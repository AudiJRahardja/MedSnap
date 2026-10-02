const u = require(require('path').join(__dirname, '..', 'ocr-utils.js'));
const cases = [
  "PANADOL\nParacetarnol 5OO rng\nTiap kaplet mengandung:",
  "Komposisi: Tiap tablet mengandung\nAm0xicilin trihidrat setara\ndengan amoksisilin 500 mg",
  "Asam Mefenamat 500mg\nSimpan di tempat kering dan sejuk",
  "Each tablet contains:\nPara cetamol 650 mg\nCaffeine 65 m9\nHARUS DENGAN RESEP DOKTER",
  "Obat Bebas Terbatas. Peringatan! Indikasi: meringankan sakit kepala\nNo. Reg: DBL1234567890A1\nExp 12 2027 Batch 0123",
  "Ibupr0fen 200 mg\nKlorfeniramin maleat 2 mg\nFenilefrin HCl 10mg",
  "OBH Combi sirup 100 ml\nDextromethorphan HBr 10 mg / 5 ml",
  "Povidone iodine 10%  solution",
  "Vitamin B complex\nThiamine 5 mg",
];
for (const c of cases) {
  console.log('---', JSON.stringify(c));
  console.log(JSON.stringify(u.extractMedications(c)));
}
