/**
 * NovaX daily operations report -> Google Sheet
 * Sheet: 17CsX3QwoGsMufwT5e5UqnQ5dxceQ49bS4LeP1k9JmQY
 *
 * Runs 3:00 AM and 3:00 PM Pakistan time.
 * Writes every column EXCEPT Expenses -- that one is Adnan's and is never
 * overwritten. Net and the green/red colouring follow whatever he types.
 *
 * SETUP (once):
 *   1. Extensions > Apps Script, paste this file, Save.
 *   2. Project Settings > Script Properties, add:
 *        SUPABASE_URL   https://rhzunbzbdzicajqtohwp.supabase.co
 *        SUPABASE_KEY   <the anon / publishable key>
 *        REPORT_TOKEN   <the same string you put in nv_ops_report_config>
 *   3. Run setupTriggers() once and approve the permission prompt.
 *   4. Run refreshNow() once to populate and format the sheet.
 */

var TAB   = 'Daily Report';
var DAYS  = 60;

/* Column order. Expenses sits between the two NovaX columns and Net so it
   reads like a bank statement. */
var HEAD = [
  'Date', 'Picked up', 'Delivered', 'Returned', 'Same-day',
  'COD collected (merchants’ money)',
  'Revenue earned (NovaX)',
  'Expenses (enter here)',
  'Net for the day',
  'Status'
];
var COL_EXPENSE = 8;   // 1-indexed: H
var COL_NET     = 9;   // I

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshNow') ScriptApp.deleteTrigger(t);
  });
  // Apps Script fires in the SHEET's timezone -- set that to Asia/Karachi
  // under File > Settings, or these run at the wrong local hour.
  ScriptApp.newTrigger('refreshNow').timeBased().atHour(3).everyDays(1).create();
  ScriptApp.newTrigger('refreshNow').timeBased().atHour(15).everyDays(1).create();
  SpreadsheetApp.getActive().setSpreadsheetTimeZone('Asia/Karachi');
}

function refreshNow() {
  var props = PropertiesService.getScriptProperties();
  var url   = props.getProperty('SUPABASE_URL');
  var key   = props.getProperty('SUPABASE_KEY');
  var token = props.getProperty('REPORT_TOKEN');
  if (!url || !key || !token) throw new Error('Script Properties are not set.');

  var res = UrlFetchApp.fetch(url + '/rest/v1/rpc/ops_daily_report', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ p_token: token, p_days: DAYS }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    stamp('Update FAILED ' + res.getResponseCode() + ' — previous numbers left untouched');
    throw new Error(res.getContentText());
  }

  var rows = JSON.parse(res.getContentText());
  if (!rows || !rows.length) { stamp('No data returned'); return; }

  var sh = ensureSheet();

  /* Read the expenses Adnan has already typed, keyed by date, so a refresh
     can never wipe them. */
  var existing = {};
  var last = sh.getLastRow();
  if (last >= 3) {
    var old = sh.getRange(3, 1, last - 2, COL_EXPENSE).getValues();
    old.forEach(function (r) {
      var d = r[0];
      if (d) existing[keyOf(d)] = r[COL_EXPENSE - 1];
    });
  }

  var out = rows.map(function (r) {
    var k = r.day;
    return [
      new Date(r.day + 'T00:00:00'),
      Number(r.picked)    || 0,
      Number(r.delivered) || 0,
      Number(r.returned)  || 0,
      Number(r.same_day)  || 0,
      Number(r.cod_collected)  || 0,
      Number(r.revenue_earned) || 0,
      existing[k] === undefined || existing[k] === '' ? '' : existing[k],
      '',                                  // Net -- formula written below
      r.is_closed ? 'Closed' : 'Provisional'
    ];
  });

  if (sh.getLastRow() >= 3) sh.getRange(3, 1, sh.getLastRow() - 2, HEAD.length).clearContent();
  sh.getRange(3, 1, out.length, HEAD.length).setValues(out);

  // Net = Revenue - Expenses. COD is deliberately NOT in this: it is the
  // merchants' money passing through, not NovaX income.
  var netFormulas = out.map(function (_, i) {
    var row = i + 3;
    return ['=G' + row + '-IF(H' + row + '="",0,H' + row + ')'];
  });
  sh.getRange(3, COL_NET, netFormulas.length, 1).setFormulas(netFormulas);

  format(sh, out.length);
  stamp('Updated');
}

function ensureSheet() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  sh.getRange(2, 1, 1, HEAD.length).setValues([HEAD])
    .setFontWeight('bold').setBackground('#0c7c59').setFontColor('#ffffff')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setFrozenRows(2);
  return sh;
}

function format(sh, n) {
  if (!n) return;
  sh.getRange(3, 1, n, 1).setNumberFormat('ddd d mmm yyyy');
  sh.getRange(3, 6, n, 4).setNumberFormat('"Rs "#,##0');
  sh.setColumnWidth(1, 140);
  for (var c = 2; c <= 5; c++) sh.setColumnWidth(c, 90);
  for (var c2 = 6; c2 <= 9; c2++) sh.setColumnWidth(c2, 165);

  // Green day / red day, applied to the whole row so it reads while scrolling.
  var body = sh.getRange(3, 1, n, HEAD.length);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($I3<>"",$I3>0)')
      .setBackground('#e6f6ee').setRanges([body]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($I3<>"",$I3<0)')
      .setBackground('#fdecea').setRanges([body]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('Provisional')
      .setFontColor('#8a5a00')
      .setRanges([sh.getRange(3, 10, n, 1)]).build()
  ]);

  // Month-to-date header block
  sh.getRange('A1').setValue('NovaX — Daily Operations').setFontWeight('bold').setFontSize(13);
  sh.getRange('E1').setFormula(
    '="MTD revenue Rs "&TEXT(SUMIFS(G3:G,A3:A,">="&EOMONTH(TODAY(),-1)+1),"#,##0")&' +
    '"   ·   MTD expenses Rs "&TEXT(SUMIFS(H3:H,A3:A,">="&EOMONTH(TODAY(),-1)+1),"#,##0")&' +
    '"   ·   MTD net Rs "&TEXT(SUMIFS(I3:I,A3:A,">="&EOMONTH(TODAY(),-1)+1),"#,##0")'
  ).setFontWeight('bold');
}

function stamp(msg) {
  var sh = SpreadsheetApp.getActive().getSheetByName(TAB);
  if (!sh) return;
  sh.getRange('J1').setValue(
    msg + ' · ' +
    Utilities.formatDate(new Date(), 'Asia/Karachi', 'd MMM, h:mm a') + ' PKT'
  ).setFontSize(10).setFontColor(msg.indexOf('FAILED') > -1 ? '#b3261e' : '#5c7568');
}

function keyOf(d) {
  return (d instanceof Date)
    ? Utilities.formatDate(d, 'Asia/Karachi', 'yyyy-MM-dd')
    : String(d).slice(0, 10);
}
