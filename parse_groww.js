const xlsx = require('xlsx');
const workbook = xlsx.readFile('F&O_PnL_Report_3078748905_2025-04-01_2026-03-31..xlsx');
const sheet_name_list = workbook.SheetNames;
const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]], {header: 1});
console.log("First 15 rows:");
for (let i = 0; i < Math.min(15, data.length); i++) {
    console.log(data[i]);
}
