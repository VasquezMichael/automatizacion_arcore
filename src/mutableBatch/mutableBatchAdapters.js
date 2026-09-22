const { sanitizeBatchOutput } = require("../batch/batchOutput");

class MutableWriteError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MutableWriteError";
    this.code = code;
    if (details) this.details = details;
  }
}

function safeProduct(product) {
  return {
    id: product?.id ?? null,
    published: product?.published ?? null,
    variants: (product?.variants || []).map((variant) => ({
      id: variant.id ?? null,
      sku: variant.sku ?? null,
      price: variant.price ?? null,
    })),
  };
}

function safeVariant(variant) {
  return {
    id: variant?.id ?? null,
    sku: variant?.sku ?? null,
    price: variant?.price ?? null,
    productId: variant?.product_id ?? variant?.productId ?? null,
  };
}

function safeImages(images) {
  return (images || []).map((image) => ({
    id: image.id ?? null,
    position: image.position ?? null,
    src: image.src || image.url || null,
  }));
}

class MutableWriteController {
  constructor({ checkpoint, checkpointItem, checkpointFile, saveCheckpoint }) {
    this.checkpoint = checkpoint;
    this.item = checkpointItem;
    this.checkpointFile = checkpointFile;
    this.saveCheckpoint = saveCheckpoint;
    this.lastRead = null;
    this.sequence = checkpoint.auditLog.length;
  }

  persist() {
    this.saveCheckpoint(this.checkpoint, this.checkpointFile);
  }

  stop(code, message, details) {
    this.checkpoint.stopped = true;
    this.checkpoint.stopReason = { code, message, ...(details ? { details } : {}) };
    this.item.state = "STOPPED";
    this.item.errors.push(this.checkpoint.stopReason);
    this.persist();
    throw new MutableWriteError(code, message, details);
  }

  recordRead(value) {
    this.lastRead = sanitizeBatchOutput(value);
  }

  beginWrite({ domain, method, resource, targetState, substate }) {
    if (this.checkpoint.stopped) {
      throw new MutableWriteError(
        "MUTABLE_BATCH_STOPPED",
        "El lote ya se encuentra detenido.",
      );
    }
    if (domain !== this.item.domain) {
      return this.stop(
        "WRITE_OUTSIDE_ENABLED_DOMAIN",
        `Se intento ${domain} mientras el item habilitado es ${this.item.domain}.`,
      );
    }
    if (this.checkpoint.writesConsumed + 1 > this.checkpoint.maxWrites) {
      return this.stop(
        "WRITE_BUDGET_EXHAUSTED",
        "El siguiente write excederia el presupuesto global.",
        {
          writesConsumed: this.checkpoint.writesConsumed,
          maxWrites: this.checkpoint.maxWrites,
        },
      );
    }

    this.sequence += 1;
    this.checkpoint.writesConsumed += 1;
    this.item.writesConsumed += 1;
    this.item.state = "WRITE_STARTED";
    this.item.substate = substate || "WRITE_STARTED";
    const audit = {
      sequence: this.sequence,
      sku: this.item.normalizedSku,
      domain,
      method,
      resource,
      preState: this.lastRead,
      targetState: sanitizeBatchOutput(targetState),
      httpResult: "STARTED",
      postState: null,
      verified: false,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.checkpoint.auditLog.push(audit);
    this.persist();
    return audit;
  }

  completeWrite(audit, response, options = {}) {
    audit.httpResult = "SUCCESS";
    audit.completedAt = new Date().toISOString();
    this.item.state = "WRITE_COMPLETED";
    this.item.substate = options.substate || "WRITE_COMPLETED";
    this.item.writeResult = {
      result: "SUCCESS",
      sequence: audit.sequence,
      method: audit.method,
      resource: audit.resource,
    };
    if (options.returnedIds) {
      Object.assign(this.item.returnedIds, sanitizeBatchOutput(options.returnedIds));
    }
    this.persist();
    return response;
  }

  failWrite(audit, error) {
    audit.httpResult = "FAILED";
    audit.completedAt = new Date().toISOString();
    audit.error = {
      code: error.code || "WRITE_FAILED",
      message: error.message,
      status: error.status || error.response?.status || null,
    };
    this.item.state = "FAILED";
    this.item.substate =
      this.item.domain === "IMAGE" &&
      audit.method === "DELETE" &&
      this.item.returnedIds?.newImageId
        ? "IMAGE_NEW_PRESENT_OLD_NOT_DELETED"
        : "WRITE_FAILED";
    this.item.writeResult = { result: "FAILED", ...audit.error };
    this.checkpoint.stopped = true;
    this.checkpoint.stopReason = audit.error;
    this.item.errors.push(audit.error);
    this.persist();
  }

  verify(postState) {
    for (const entry of this.checkpoint.auditLog) {
      if (entry.sku === this.item.normalizedSku && entry.domain === this.item.domain) {
        entry.postState = sanitizeBatchOutput(postState);
        entry.verified = true;
      }
    }
    this.item.state = "VERIFIED";
    this.item.substate = "VERIFIED";
    this.item.verification = { verified: true, state: sanitizeBatchOutput(postState) };
    this.persist();
  }
}

function wrapWrite(controller, metadata, operation, completed = {}) {
  return async (...args) => {
    const audit = controller.beginWrite(metadata(...args));
    try {
      const response = await operation(...args);
      const options = typeof completed === "function" ? completed(response, args) : completed;
      return controller.completeWrite(audit, response, options);
    } catch (error) {
      controller.failWrite(audit, error);
      throw error;
    }
  };
}

function instrumentPriceAdapter(adapter, controller) {
  return {
    async getProduct(productId) {
      const product = await adapter.getProduct(productId);
      controller.recordRead(safeProduct(product));
      return product;
    },
    async getProductVariant(productId, variantId) {
      const variant = await adapter.getProductVariant(productId, variantId);
      controller.recordRead(safeVariant(variant));
      return variant;
    },
    updateVariantPrice: wrapWrite(
      controller,
      (productId, variantId, price) => ({
        domain: "PRICE",
        method: "PUT",
        resource: `/products/${productId}/variants/${variantId}`,
        targetState: { price },
      }),
      adapter.updateVariantPrice.bind(adapter),
    ),
  };
}

function instrumentStatusAdapter(adapter, controller) {
  return {
    async getProduct(productId) {
      const product = await adapter.getProduct(productId);
      controller.recordRead(safeProduct(product));
      return product;
    },
    updateProductPublished: wrapWrite(
      controller,
      (productId, published) => ({
        domain: "STATUS",
        method: "PUT",
        resource: `/products/${productId}`,
        targetState: { published },
      }),
      adapter.updateProductPublished.bind(adapter),
    ),
  };
}

function instrumentImageAdapter(adapter, controller) {
  return {
    async getProduct(productId) {
      const product = await adapter.getProduct(productId);
      controller.recordRead(safeProduct(product));
      return product;
    },
    async listProductImages(productId) {
      const images = await adapter.listProductImages(productId);
      controller.recordRead({ productId, images: safeImages(images) });
      return images;
    },
    uploadProductImage: wrapWrite(
      controller,
      (productId, payload) => ({
        domain: "IMAGE",
        method: "POST",
        resource: `/products/${productId}/images`,
        targetState: payload,
        substate: "IMAGE_POST_STARTED",
      }),
      adapter.uploadProductImage.bind(adapter),
      (response) => ({
        substate: "IMAGE_NEW_PRESENT_OLD_NOT_DELETED",
        returnedIds: { newImageId: response?.id ?? null },
      }),
    ),
    deleteProductImage: wrapWrite(
      controller,
      (productId, imageId) => ({
        domain: "IMAGE",
        method: "DELETE",
        resource: `/products/${productId}/images/${imageId}`,
        targetState: { deleteImageId: imageId },
        substate: "IMAGE_DELETE_STARTED",
      }),
      adapter.deleteProductImage.bind(adapter),
      (_response, args) => ({
        substate: "IMAGE_DELETE_COMPLETED",
        returnedIds: { deletedImageId: args[1] },
      }),
    ),
  };
}

function instrumentCreateAdapter(adapter, controller) {
  return {
    async findSkuMatches(normalizedSku) {
      const lookup = await adapter.findSkuMatches(normalizedSku);
      controller.recordRead({
        normalizedSku,
        matchCount: lookup?.matches?.length || 0,
        matches: lookup?.matches || [],
      });
      return lookup;
    },
    createProduct: wrapWrite(
      controller,
      () => ({
        domain: "CREATE",
        method: "POST",
        resource: "/products",
        targetState: { operation: "CREATE_SINGLE" },
        substate: "CREATE_POST_STARTED",
      }),
      adapter.createProduct.bind(adapter),
      (response) => ({
        substate: "CREATE_POST_COMPLETED",
        returnedIds: {
          createdProductId: response?.id ?? null,
          createdVariantId: response?.variants?.[0]?.id ?? null,
        },
      }),
    ),
    getProduct: adapter.getProduct.bind(adapter),
    listProductImages: adapter.listProductImages.bind(adapter),
  };
}

module.exports = {
  MutableWriteController,
  MutableWriteError,
  instrumentCreateAdapter,
  instrumentImageAdapter,
  instrumentPriceAdapter,
  instrumentStatusAdapter,
  safeImages,
  safeProduct,
  safeVariant,
};
