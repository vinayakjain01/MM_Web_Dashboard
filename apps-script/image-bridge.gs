// Standalone Apps Script, deployed as a Web App. Bridges a real gap in the Sheets REST
// API: floating images (Insert > Image > Insert image over cells) are completely
// invisible to spreadsheets.get/values.get -- the cell reads as 100% empty, confirmed by
// direct testing. Sheet.getImages() is an Apps Script-only capability that can see them.
//
// Read-only. Does not require Editor access to the target spreadsheet -- only whatever
// access the script's own execution identity already has (Viewer is enough), since this
// only reads image positions, never writes anything.
//
// Setup: see README.md "Apps Script image bridge" section.

function doGet(e) {
  var expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!expectedSecret || e.parameter.secret !== expectedSecret) {
    return jsonResponse({ error: 'unauthorized' });
  }

  var spreadsheetId = e.parameter.spreadsheetId;
  if (!spreadsheetId) {
    return jsonResponse({ error: 'missing spreadsheetId' });
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (err) {
    return jsonResponse({ error: 'could not open spreadsheet: ' + err.message });
  }

  var sheetNamesParam = e.parameter.sheetNames; // comma-separated; omit for every sheet
  var sheets = sheetNamesParam
    ? sheetNamesParam.split(',').map(function (n) { return ss.getSheetByName(n); }).filter(Boolean)
    : ss.getSheets();

  var result = {};
  sheets.forEach(function (sheet) {
    var images = sheet.getImages();
    result[sheet.getName()] = images.map(function (img) {
      var cell = img.getAnchorCell();
      return { row: cell.getRow(), column: cell.getColumn() }; // both 1-indexed
    });
  });

  return jsonResponse({ data: result });
}

function jsonResponse(body) {
  // Apps Script web apps always answer HTTP 200 for doGet (no way to set a real status
  // code here) -- callers must treat a body.error field as the failure signal instead.
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
