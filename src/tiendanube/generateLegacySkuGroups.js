const { generateLegacySkuGroupsFromAudit } = require("./legacySkuGroups");

async function main() {
  try {
    const { filePath, groups } = generateLegacySkuGroupsFromAudit();
    const groupCount = Object.keys(groups).length;
    const publicationCount = Object.values(groups).reduce(
      (total, group) => total + group.expectedMatches,
      0,
    );

    console.log("Registro historico de SKUs duplicados generado.");
    console.log(`- archivo: ${filePath}`);
    console.log(`- grupos LEGACY_GROUP: ${groupCount}`);
    console.log(`- publicaciones historicas registradas: ${publicationCount}`);
    console.log(
      "- Este archivo es una whitelist historica; no debe autoextenderse durante sync.",
    );
  } catch (error) {
    console.error("Error generando registro historico de SKUs:", error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
