import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(pathToFileURL(path.resolve('index.html')).href);
  assert.equal(await page.locator('#stageConfigModal').isVisible(), false);
  assert.equal(await page.locator('#mainContent').isVisible(), true);
  assert.equal(await page.locator('#reviewNoDataState').isVisible(), true);
  assert.equal(await page.locator('#fileInput').isEnabled(), false);
  await page.locator('#topUploadAction').click();
  assert.equal(await page.locator('#stageConfigModal').isVisible(), true);
  assert.equal(await page.locator('[data-stage-label]').count(), 9);
  await page.getByRole('button', { name: '新增阶段' }).click();
  await page.getByRole('button', { name: '新增阶段' }).click();
  assert.equal(await page.locator('[data-stage-label]').count(), 11);

  for (let i = 0; i < 7; i++) {
    await page.getByRole('button', { name: '删除最后阶段' }).click();
  }
  await page.locator('[data-stage-label]').first().fill('投递');
  const firstChooserPromise = page.waitForEvent('filechooser');
  await page.locator('#confirmStageConfigButton').click();
  await firstChooserPromise;
  assert.equal(await page.locator('#fileInput').isEnabled(), true);
  assert.deepEqual((await page.evaluate(() => window.getCurrentStages())).map(stage => stage.code), [0, 1, 2, 3]);
  assert.equal((await page.evaluate(() => window.getCurrentStages()))[0].label, '投递');

  const funnel = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '筛选', '面试', '入职']);
    return window.generateFunnelAnalysisForTest([
      { stageCode: 0, status: 'in_progress', unknownTerminated: false },
      { stageCode: 3, status: 'passed', unknownTerminated: false }
    ]);
  });
  assert.deepEqual(funnel.map(stage => stage.label), ['投递', '筛选', '面试', '入职']);
  assert.deepEqual(funnel.map(stage => stage.count), [2, 1, 1, 1]);
  const funnelText = await page.evaluate(funnelData => {
    window.renderFunnel(funnelData, 'funnelContainer');
    return document.querySelector('#funnelContainer').textContent;
  }, funnel);
  assert.match(funnelText, /投递/);
  assert.match(funnelText, /入职/);
  assert.doesNotMatch(funnelText, /简历评审/);
  const escapedFunnel = await page.evaluate(() => {
    window.setCurrentStagesForTest(['<img src=x onerror=alert(1)>', '入职']);
    window.renderFunnel([{ code: 0, label: '<img src=x onerror=alert(1)>', count: 1, color: '#000', conversionRate: 0, dropoutRate: 0 }, { code: 1, label: '入职', count: 1, color: '#000', conversionRate: 100, dropoutRate: 0 }], 'funnelContainer');
    return { imageCount: document.querySelectorAll('#funnelContainer img').length, text: document.querySelector('#funnelContainer').textContent };
  });
  assert.equal(escapedFunnel.imageCount, 0);
  assert.match(escapedFunnel.text, /<img src=x onerror=alert\(1\)>/);

  const stageNine = await page.evaluate(() => {
    window.setCurrentStagesForTest(['0', '1', '2', '3', '4', '5', '6', '7', '8', '审批', '入职']);
    return window.parseMainStatus('9-审批');
  });
  assert.deepEqual(stageNine, { code: 9, name: '审批' });

  const templateDraft = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '初筛', '一面', 'Offer']);
    return buildRecruitmentTemplateDraft(getCurrentStages());
  });
  assert.deepEqual(templateDraft.sheetNames, ['使用说明', '招聘数据模板', '阶段配置示例']);
  assert.deepEqual(templateDraft.mainStageOptions, ['0-投递', '1-初筛', '2-一面', '3-Offer']);
  assert.deepEqual(templateDraft.dateHeaders, [
    '0-投递日期', '1-初筛日期', '2-一面日期', '3-Offer日期'
  ]);
  assert.equal(templateDraft.dataHeaders.at(-1), '3-Offer日期');

  const templatePage = await browser.newPage();
  await templatePage.goto(pathToFileURL(path.resolve('index.html')).href);
  await templatePage.locator('#topUploadAction').click();
  await templatePage.locator('[data-stage-label]').first().fill('投递');
  await templatePage.getByRole('button', { name: '预览动态模板' }).click();
  assert.equal(await templatePage.locator('#templatePreviewModal').isVisible(), true);
  assert.equal(await templatePage.locator('[data-template-preview-tab="data"]').isVisible(), true);
  await templatePage.locator('[data-template-preview-tab="data"]').click();
  assert.equal(await templatePage.locator('#templatePreviewGrid').isVisible(), true);
  assert.match(await templatePage.locator('#templatePreviewGrid').textContent(), /主阶段/);
  assert.match(await templatePage.locator('#templatePreviewGrid').textContent(), /0-投递 ▾/);
  assert.match(await templatePage.locator('#templatePreviewDataHeaders').textContent(), /0-投递日期/);
  await templatePage.locator('[data-stage-label]').first().fill('简历筛选');
  assert.equal(await templatePage.locator('#templatePreviewStale').isVisible(), true);
  assert.match(await templatePage.locator('#templatePreviewDataHeaders').textContent(), /0-投递日期/);
  assert.doesNotMatch(await templatePage.locator('#templatePreviewDataHeaders').textContent(), /0-简历筛选日期/);

  const generatedTemplate = await page.evaluate(async () => {
    const draft = buildRecruitmentTemplateDraft([
      { code: 0, label: '投递' }, { code: 1, label: '筛选' }, { code: 2, label: '面试' }
    ]);
    const blob = buildRecruitmentTemplateWorkbook(draft);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const workbook = await XLSX.read(bytes.buffer);
    const importedRows = await readExcelAllSheets(bytes.buffer);
    return {
      sheetNames: workbook.SheetNames,
      usageRows: XLSX.utils.sheet_to_json(workbook.Sheets['使用说明'], { header: 1, defval: '' }),
      stageRows: XLSX.utils.sheet_to_json(workbook.Sheets['阶段配置示例'], { header: 1, defval: '' }),
      headers: XLSX.utils.sheet_to_json(workbook.Sheets['招聘数据模板'], { header: 1, defval: '' })[0],
      packageText: new TextDecoder().decode(bytes),
      importedRows,
      mappedSheets: Object.keys(sheetColumnMappings)
    };
  });
  assert.deepEqual(generatedTemplate.sheetNames, ['使用说明', '招聘数据模板', '阶段配置示例']);
  assert.match(generatedTemplate.usageRows.flat().join(' '), /进行中、通过、终止/);
  assert.match(generatedTemplate.usageRows.flat().join(' '), /终止原因示例/);
  assert.match(generatedTemplate.stageRows[0].join(' '), /阶段状态选项/);
  assert.match(generatedTemplate.stageRows[0].join(' '), /终止原因示例/);
  assert.deepEqual(generatedTemplate.headers.slice(-3), ['0-投递日期', '1-筛选日期', '2-面试日期']);
  assert.match(generatedTemplate.packageText, /definedName name="MainStageOptions"/);
  assert.match(generatedTemplate.packageText, /<formula1>MainStageOptions<\/formula1>/);
  assert.match(generatedTemplate.packageText, /<formula1>StatusOptions<\/formula1>/);
  assert.deepEqual(generatedTemplate.importedRows, []);
  assert.deepEqual(generatedTemplate.mappedSheets, []);

  const sheetFallbackImport = await page.evaluate(async () => {
    const sheetNames = ['AI支付产品', 'Sheet1', '招聘数据模板', 'Sheet2'];
    const headers = ['候选人姓名', '简历收取时间', 'A.主阶段', 'B.阶段状态', '岗位名称'];
    const records = [
      ['候选人A', '2026-08-01', '0-投递', '进行中', ''],
      ['候选人B', '2026-08-01', '0-投递', '进行中', ''],
      ['候选人C', '2026-08-01', '0-投递', '进行中', ''],
      ['候选人D', '2026-08-01', '0-投递', '进行中', '行内岗位']
    ];
    const sheets = records.map(record => buildXlsxSheetXml([headers, record]));
    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheetNames.map((name, index) => '<sheet name="' + xmlEscape(name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>').join('') + '</sheets></workbook>';
    const entries = [
      { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_, index) => '<Override PartName="/xl/worksheets/sheet' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' },
      { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', content: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, index) => '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>').join('') + '</Relationships>' }
    ].concat(sheets.map((content, index) => ({ name: 'xl/worksheets/sheet' + (index + 1) + '.xml', content })));
    const bytes = createStoredZip(entries);
    const rows = await readExcelAllSheets(bytes.buffer);
    const transformed = transformData(rows);
    return {
      resumeTimeSheetIsRecognized: isRecruitmentDataSheet('仅日期字段', ['简历收取时间', '0-投递日期']),
      importedSheetNames: rows.map(row => row.__sheetName),
      jobs: Object.fromEntries(transformed.map(row => [row.candidateName, row.jobName])),
      resumeTimes: Object.fromEntries(transformed.map(row => [row.candidateName, row.resumeTime instanceof Date ? row.resumeTime.toISOString().slice(0, 10) : '']))
    };
  });
  assert.equal(sheetFallbackImport.resumeTimeSheetIsRecognized, true);
  assert.deepEqual(sheetFallbackImport.importedSheetNames, ['AI支付产品', 'Sheet1', '招聘数据模板', 'Sheet2']);
  assert.equal(sheetFallbackImport.resumeTimes['候选人A'], '2026-08-01');
  assert.equal(sheetFallbackImport.jobs['候选人A'], 'AI支付产品');
  assert.equal(sheetFallbackImport.jobs['候选人B'], '');
  assert.equal(sheetFallbackImport.jobs['候选人C'], '');
  assert.equal(sheetFallbackImport.jobs['候选人D'], '行内岗位');

  const maxStageDraft = await page.evaluate(() => buildRecruitmentTemplateDraft(
    Array.from({ length: 11 }, (_, code) => ({ code, label: '阶段' + code }))
  ));
  assert.equal(maxStageDraft.mainStageOptions.at(-1), '10-阶段10');
  assert.equal(maxStageDraft.dateHeaders.at(-1), '10-阶段10日期');
  assert.equal(await templatePage.evaluate(() => typeof downloadRecruitmentTemplate), 'function');
  await templatePage.getByRole('button', { name: '关闭' }).click();
  const downloadPromise = templatePage.waitForEvent('download');
  await templatePage.getByRole('button', { name: '下载 Excel 模板' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), '招聘数据上传模板.xlsx');

  const draftSyncPage = await browser.newPage();
  await draftSyncPage.goto(pathToFileURL(path.resolve('index.html')).href);
  await draftSyncPage.locator('#topUploadAction').click();
  await draftSyncPage.locator('[data-stage-label]').nth(0).fill('投递');
  await draftSyncPage.locator('[data-stage-label]').nth(1).fill('初筛');
  await draftSyncPage.getByRole('button', { name: '删除最后阶段' }).click();
  assert.deepEqual(await draftSyncPage.locator('[data-stage-label]').evaluateAll(inputs => inputs.slice(0, 2).map(input => input.value)), ['投递', '初筛']);
  await draftSyncPage.getByRole('button', { name: '新增阶段' }).click();
  assert.deepEqual(await draftSyncPage.locator('[data-stage-label]').evaluateAll(inputs => inputs.slice(0, 2).map(input => input.value)), ['投递', '初筛']);

  const cancelDraftPage = await browser.newPage();
  await cancelDraftPage.goto(pathToFileURL(path.resolve('index.html')).href);
  const stagesBeforeCancel = await cancelDraftPage.evaluate(() => window.getCurrentStages());
  await cancelDraftPage.locator('#topUploadAction').click();
  await cancelDraftPage.getByRole('button', { name: '新增阶段' }).click();
  await cancelDraftPage.locator('[data-stage-label]').first().fill('不应保存的阶段名');
  await cancelDraftPage.getByRole('button', { name: '取消' }).click();
  assert.deepEqual(await cancelDraftPage.evaluate(() => window.getCurrentStages()), stagesBeforeCancel);
  await cancelDraftPage.locator('#topUploadAction').click();
  assert.equal(await cancelDraftPage.locator('[data-stage-label]').count(), stagesBeforeCancel.length);
  assert.equal(await cancelDraftPage.locator('[data-stage-label]').first().inputValue(), stagesBeforeCancel[0].label);

  const validationPage = await browser.newPage();
  await validationPage.goto(pathToFileURL(path.resolve('index.html')).href);
  await validationPage.locator('#topUploadAction').click();
  await validationPage.locator('[data-stage-label]').nth(1).fill('简历评审');
  await validationPage.locator('#confirmStageConfigButton').click();
  assert.equal(await validationPage.locator('#stageConfigModal').isVisible(), true);
  assert.match(await validationPage.locator('#stageConfigError').textContent(), /不能重复/);
  const stageDateImport = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '笔试', '技术面', '入职']);
    const [item] = window.transformDataForTest([{
      '主阶段': '2-技术面',
      '阶段状态': '进行中',
      '0-投递日期': '2026-07-01',
      '1-笔试日期': '2026-07-03',
      '2-技术面日期': '2026-07-06',
      '3-入职日期': ''
    }]);
    const [labelOnlyItem] = window.transformDataForTest([{
      '主阶段': '2-技术面',
      '阶段状态': '进行中',
      '投递日期': '2026-07-01',
      '笔试日期': '2026-07-03',
      '技术面日期': '2026-07-06'
    }]);
    window.setCurrentStagesForTest(['投递', '笔试', '业务一面', '入职']);
    const [compatibleLabelItem] = window.transformDataForTest([{
      '主阶段': '2-技术面',
      '阶段状态': '进行中',
      '一面日期': '2026-07-06'
    }]);
    const [unrelatedLabelItem] = window.transformDataForTest([{
      '主阶段': '2-业务一面',
      '阶段状态': '进行中',
      '二面日期': '2026-07-06'
    }]);
    return {
      stageDates: Object.fromEntries(Object.entries(item.stageDates).map(([code, date]) => [code, date.toISOString().slice(0, 10)])),
      stageDateParseFailed: item.stageDateParseFailed,
      labelOnlyStageDates: Object.fromEntries(Object.entries(labelOnlyItem.stageDates).map(([code, date]) => [code, date.toISOString().slice(0, 10)])),
      compatibleLabelStageDates: Object.fromEntries(Object.entries(compatibleLabelItem.stageDates).map(([code, date]) => [code, date.toISOString().slice(0, 10)])),
      unrelatedLabelStageDates: Object.fromEntries(Object.entries(unrelatedLabelItem.stageDates).map(([code, date]) => [code, date.toISOString().slice(0, 10)]))
    };
  });
  assert.deepEqual(stageDateImport.stageDates, { 0: '2026-07-01', 1: '2026-07-03', 2: '2026-07-06' });
  assert.equal(stageDateImport.stageDateParseFailed, false);
  assert.deepEqual(stageDateImport.labelOnlyStageDates, { 0: '2026-07-01', 1: '2026-07-03', 2: '2026-07-06' });
  assert.deepEqual(stageDateImport.compatibleLabelStageDates, { 2: '2026-07-06' });
  assert.deepEqual(stageDateImport.unrelatedLabelStageDates, {});

  const stayDuration = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '笔试', '技术面', '入职']);
    const now = new Date('2026-07-20T00:00:00');
    const withoutDates = { status: 'in_progress', stageCode: 2, stageDates: {} };
    return {
      currentStage: window.getStayDayCountForTest({ status: 'in_progress', stageCode: 2, stageDates: { 1: new Date('2026-07-16T00:00:00'), 2: new Date('2026-07-15T00:00:00') } }, now),
      fallbackStage: window.getStayDayCountForTest({ status: 'in_progress', stageCode: 2, stageDates: { 1: new Date('2026-07-16T00:00:00') } }, now),
      currentDateOnly: window.getStayDayCountForTest({ status: 'in_progress', stageCode: 2, stageDates: { 2: new Date('2026-07-15T00:00:00') } }, now),
      firstStageFallback: window.getStayDayCountForTest({ status: 'in_progress', stageCode: 0, stageDates: {}, resumeTime: new Date('2026-07-15T00:00:00') }, now),
      missingDate: window.getStayDayCountForTest(withoutDates, now),
      passed: window.getStayDayCountForTest({ status: 'passed', stageCode: 3, stageDates: { 3: new Date('2026-01-01T00:00:00') } }, now),
      future: window.getStayDayCountForTest({ status: 'in_progress', stageCode: 2, stageDates: { 2: new Date('2026-08-01T00:00:00') } }, now),
      missingDateTags: window.getCandidateRiskTagsForTest(withoutDates).tags.map(tag => tag.label)
    };
  });
  assert.equal(stayDuration.currentStage, 5);
  assert.equal(stayDuration.fallbackStage, 4);
  assert.equal(stayDuration.currentDateOnly, 5);
  assert.equal(stayDuration.firstStageFallback, 5);
  assert.equal(stayDuration.missingDate, null);
  assert.equal(stayDuration.passed, null);
  assert.equal(stayDuration.future, null);
  assert.equal(stayDuration.missingDateTags.some(label => label.includes('停留超 7 天')), false);

  const transitionDuration = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '笔试', '技术面', '终面']);
    const rows = [
      { stageCode: 3, status: 'passed', stageDates: { 0: new Date('2026-07-02'), 1: new Date('2026-07-04'), 2: new Date('2026-07-07'), 3: new Date('2026-07-10') } },
      { stageCode: 3, status: 'in_progress', stageDates: { 0: new Date('2026-07-04'), 1: new Date('2026-07-06'), 2: new Date('2026-07-10'), 3: new Date('2026-07-12') } },
      { stageCode: 3, status: 'passed', stageDates: { 0: new Date('2026-07-04'), 2: new Date('2026-07-09') } }
    ];
    const funnel = window.generateFunnelAnalysisForTest(rows);
    window.renderStageTimingPanelForTest(funnel);
    return {
      first: funnel[0],
      second: funnel[1],
      third: funnel[2],
      fourth: funnel[3],
      timing: document.querySelector('#stageTimingCard').textContent,
      timingInfo: document.querySelector('#stageTimingCard .info-trigger')?.getAttribute('aria-label') || '',
      timingRows: document.querySelectorAll('#stageTimingList .stage-timing-row').length
    };
  });
  assert.equal(transitionDuration.first.avgTransitionDays, 3);
  assert.equal(transitionDuration.first.transitionDateCoverage, 3);
  assert.equal(transitionDuration.first.transitionEligibleCount, 3);
  assert.equal(transitionDuration.second.avgTransitionDays, 3.5);
  assert.equal(transitionDuration.third.avgTransitionDays, 2.5);
  assert.equal(transitionDuration.third.transitionDateCoverage, 2);
  assert.equal(transitionDuration.third.transitionEligibleCount, 3);
  assert.equal(transitionDuration.third.transitionTimeStats.coverageRate, 66.7);
  assert.equal(transitionDuration.fourth.transitionDateCoverage, 0);
  assert.match(transitionDuration.timing, /阶段招聘时效/);
  assert.match(transitionDuration.timingInfo, /阶段招聘时效/);
  assert.equal(transitionDuration.timingRows, 3);

  const dynamicAnalytics = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '笔试', '技术面', '终面', '入职']);
    const rows = [
      { jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 0, status: 'in_progress' },
      { jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 2, status: 'in_progress' },
      { jobName: '岗位B', source: '渠道B', company: '公司B', stageCode: 4, status: 'passed' }
    ];
    const channel = window.buildChannelAnalysisForTest(rows);
    const company = window.buildCompanyAnalysisForTest(rows);
    const jobs = window.buildJobComparisonForTest(rows);
    return {
      channel: channel.find(row => row.source === '渠道A'),
      company: company.find(row => row.company === '公司A'),
      job: jobs.find(row => row.jobName === '岗位A')
    };
  });
  assert.deepEqual(dynamicAnalytics.channel.stageCounts, { 0: 2, 1: 1, 2: 1, 3: 0, 4: 0 });
  assert.deepEqual(dynamicAnalytics.company.stageCounts, { 0: 2, 1: 1, 2: 1, 3: 0, 4: 0 });
  assert.deepEqual(dynamicAnalytics.job.transitionRates, [50, 100, 0, 0]);

  const controlsPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await controlsPage.goto(pathToFileURL(path.resolve('index.html')).href);
  assert.equal(await controlsPage.locator('#reviewNoDataState').isVisible(), true);
  assert.equal(await controlsPage.locator('.actions-bar').getByRole('button', { name: '上传表格' }).count(), 0);
  assert.equal(await controlsPage.getByRole('button', { name: '上传数据' }).isVisible(), true);
  assert.equal(await controlsPage.getByRole('button', { name: '阶段配置' }).count(), 0);
  await controlsPage.getByRole('button', { name: '上传数据' }).click();
  assert.equal(await controlsPage.locator('#stageConfigModal').isVisible(), true);
  const modalStyle = await controlsPage.locator('.stage-config-modal').evaluate(el => getComputedStyle(el).maxHeight);
  assert.notEqual(modalStyle, 'none');
  const chooserPromise = controlsPage.waitForEvent('filechooser');
  await controlsPage.locator('#confirmStageConfigButton').click();
  await chooserPromise;

  const attentionBoard = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '笔试', '技术面', '入职']);
    const rows = [
      { candidateName: '已入职', stageName: '入职', stageCode: 3, status: 'passed', stageDates: { 2: new Date('2026-07-01T00:00:00') } },
      { candidateName: '待推进', stageName: '技术面', stageCode: 2, status: 'in_progress', stageDates: { 1: new Date('2026-07-10T00:00:00') } }
    ];
    window.setRawDataForTest(rows);
    window.renderAttentionBoardForTest(rows);
    return {
      candidates: window.getAttentionCandidatesForTest(rows).map(item => item.candidateName),
      headers: Array.from(document.querySelectorAll('#attentionCandidateTable th')).map(cell => cell.textContent)
    };
  });
  assert.deepEqual(attentionBoard.candidates, ['待推进']);
  assert.equal(attentionBoard.headers.includes('停留/关键日期'), true);
  assert.equal(attentionBoard.headers.includes('风险'), true);

  const emptyRiskSummaryCount = await page.evaluate(() => {
    const rows = [{
      candidateName: '候选人完整', jobName: '岗位A', company: '公司A', source: '渠道A',
      stageName: '技术面', stageCode: 2, status: 'in_progress',
      resumeTime: new Date('2026-07-18T00:00:00'), stageDates: { 2: new Date('2026-07-19T00:00:00') }
    }];
    window.renderAttentionBoardForTest(rows);
    return document.querySelectorAll('#attentionRiskSummary .attention-risk-card').length;
  });
  assert.equal(emptyRiskSummaryCount, 0);

  const terminationSummary = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '初筛', '技术面', '入职']);
    const rows = [
      { candidateId: 'a', stageCode: 2, stageName: '一面', status: 'terminated', processState: 'terminated_recruitment', reasonClassification: { level1Category: '匹配与评估', level2Reason: '淘汰/不合适', controllability: '业务侧可控' } },
      { candidateId: 'b', stageCode: 1, stageName: '电话联系', status: 'terminated', processState: 'terminated_recruitment', reasonClassification: { level1Category: '候选人意愿', level2Reason: '不看机会/无意向', controllability: '候选人侧' } }
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    return result.reasonMatrix.map(row => row.stageLabel).join('、');
  });
  assert.match(terminationSummary, /技术面/);
  assert.match(terminationSummary, /初筛/);
  assert.doesNotMatch(terminationSummary, /一面|电话联系/);

  const stageTimingText = await page.evaluate(() => {
    window.renderStageTimingPanelForTest([{ code: 0, label: '投递', transitionTimeStats: { averageDays: 2 } }]);
    return document.querySelector('#stageTimingCard').textContent;
  });
  assert.match(stageTimingText, /阶段招聘时效/);
  assert.match(stageTimingText, /2\.0天/);
} finally {
  await browser.close();
}
