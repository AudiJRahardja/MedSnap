// Ordinary label words (Indonesian + English) must never match a drug name.
const u = require(require('path').join(__dirname, '..', 'ocr-utils.js'));
const words = `tablet kaplet kapsul komposisi indikasi dosis aturan pakai mengandung simpan kering sejuk terlindung
cahaya harus dengan resep dokter obat bebas terbatas peringatan kemasan strip blister batch expired manufactured
registration each contains fever pain headache relief tempat sakit kepala demam flu batuk pilek hidung tersumbat
dewasa anak sehari kali sesudah makan sebelum diproduksi oleh jakarta indonesia film coated sirup suspensi salep
krim tetes mata minum air putih efek samping kontra hamil menyusui overdosis hati ginjal informasi lebih lanjut
hubungi konsumen layanan farmasi apoteker netto berat bersih setara tiap butir botol dus isi exp mfg tanggal
kadaluarsa nomor registrasi produksi distributor sehat medika lestari nusantara kimia pharma indofarma kalbe sanbe
dexa combiphar konimex sido muncul deltomed bayi tahun bulan minggu hari jam pagi siang malam tidur kantuk
mengemudi alkohol lambung maag mual muntah diare sembelit nyeri otot sendi gigi haid luka gatal jamur kulit
kemerahan bengkak radang tenggorokan alergi asma sesak napas darah tinggi rendah gula kolesterol jantung saraf
vitamin mineral suplemen herbal tradisional jamu madu jahe kunyit temulawak minyak kayu putih balsem koyo plester
perban kapas termometer masker lasik media pantai visit cendol rohtak losers medal lameness medrolin amarylis
ketentuan ventilasi venting ardiun ambevan sakit tonik feminin buscop motil lipid zylo voltase`.split(/\s+/);
const hits = u.findDrugNames(words.join('\n'));
console.log(hits.length ? hits.map(m => `${m.matched} -> ${m.name}`).join('\n') : 'no false positives');
console.log('dictionary:', u.DRUG_GROUPS.length, 'generic groups,', u.BRAND_GROUPS.length, 'brands');
