import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const cases = [];

function test(name, run) {
  cases.push({ name, run });
}

function makeCandidate(overrides = {}) {
  return {
    candidateId: 'candidate-1',
    candidateName: '候选人A',
    jobName: '岗位A',
    source: '渠道A',
    company: '公司A',
    stageCode: 0,
    stageName: '简历评审',
    status: 'in_progress',
    processState: 'in_progress',
    resumeTime: '2026-08-01',
    stageDates: { 0: '2026-08-01' },
    stagePassDates: {},
    offerAcceptedDate: null,
    expectedOnboardDate: null,
    stayDays: 1,
    slaDays: 3,
    slaState: 'within',
    rawTerminationReason: '',
    rawRemark: '',
    reasonClassification: null,
    qualityIssues: [],
    unknownTerminated: false,
    ...overrides
  };
}

test('公开稳定的 P0 数据契约', async () => {
  const contract = await page.evaluate(() => window.getP0ContractForTest());
  assert.deepEqual(contract.processStates, [
    'in_progress',
    'passed_pending_next',
    'offer_accepted_pending_onboard',
    'completed',
    'terminated_recruitment',
    'terminated_business',
    'terminated_unknown_reason'
  ]);
  assert.deepEqual(contract.mainViews, ['review', 'reviewAnalysis', 'details', 'attention']);
});

test('阶段配置包含 SLA，模板包含通过日期和 Offer 日期', async () => {
  const result = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    const stages = window.getCurrentStages();
    const draft = buildRecruitmentTemplateDraft(stages);
    return {
      slaDays: stages.map(stage => stage.slaDays),
      passDateHeaders: draft.passDateHeaders,
      headers: draft.dataHeaders
    };
  });
  assert.deepEqual(result.slaDays, [3, 5, 3, 5]);
  assert.deepEqual(result.passDateHeaders, [
    '0-简历评审通过日期',
    '1-一面通过日期',
    '2-Offer通过日期',
    '3-入职通过日期'
  ]);
  assert.ok(result.headers.includes('Offer接受日期'));
  assert.ok(result.headers.includes('预计入职日期'));
  assert.ok(result.headers.includes('2-Offer日期'));
});

test('导入阶段通过日期和 Offer 生命周期日期', async () => {
  const result = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    const item = window.transformDataForTest([{
      主阶段: '2-Offer',
      阶段状态: '通过',
      候选人姓名: '候选人A',
      '2-Offer日期': '2026-08-01',
      '2-Offer通过日期': '2026-08-04',
      Offer接受日期: '2026-08-05',
      预计入职日期: '2026-08-20'
    }])[0];
    const day = value => value ? new Date(value).toISOString().slice(0, 10) : null;
    return {
      stageDate: day(item.stageDates[2]),
      passDate: day(item.stagePassDates?.[2]),
      offerAcceptedDate: day(item.offerAcceptedDate),
      expectedOnboardDate: day(item.expectedOnboardDate)
    };
  });
  assert.deepEqual(result, {
    stageDate: '2026-08-01',
    passDate: '2026-08-04',
    offerAcceptedDate: '2026-08-05',
    expectedOnboardDate: '2026-08-20'
  });
});

test('库存状态不算流失，业务终止计入流失并单列', async () => {
  const result = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    const samples = [
      { stageCode: 1, status: 'passed', rawTerminationReason: '', rawRemark: '' },
      { stageCode: 2, status: 'passed', offerAcceptedDate: '2026-08-05', rawTerminationReason: '', rawRemark: '' },
      { stageCode: 1, status: 'terminated', rawTerminationReason: '岗位关闭', rawRemark: '' },
      { stageCode: 1, status: 'terminated', rawTerminationReason: '淘汰', rawRemark: '' }
    ];
    return samples.map(item => {
      const reason = window.buildReasonClassificationForTest(item);
      return {
        processState: window.resolveProcessStateForTest({ ...item, reasonClassification: reason }),
        reason
      };
    });
  });
  assert.equal(result[0].processState, 'passed_pending_next');
  assert.equal(result[1].processState, 'offer_accepted_pending_onboard');
  assert.equal(result[2].processState, 'terminated_business');
  assert.equal(result[2].reason.level1Category, '业务/HC');
  assert.equal(result[2].reason.confidence, 'high');
  assert.equal(result[3].processState, 'terminated_recruitment');
  assert.equal(result[3].reason.rawReason, '淘汰');
  assert.equal(result[3].reason.missingSpecificReason, false);
});

test('没有 Offer 阶段时不生成 Offer 待入职状态', async () => {
  const state = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', '审批', '入职']);
    const item = {
      stageCode: 2,
      status: 'passed',
      offerAcceptedDate: '2026-08-05',
      rawRemark: '已接受'
    };
    return window.resolveProcessStateForTest(item);
  });
  assert.equal(state, 'passed_pending_next');
});

test('阶段指标只把已终止记录计为真实流失', async () => {
  const metrics = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '面试', 'Offer', '入职']);
    const rows = [
      { stageCode: 0, processState: 'in_progress', stayDays: 2, slaState: 'within' },
      { stageCode: 0, processState: 'passed_pending_next', stayDays: 4, slaState: 'overdue' },
      { stageCode: 1, processState: 'terminated_recruitment' },
      { stageCode: 1, processState: 'terminated_business' },
      { stageCode: 1, processState: 'terminated_unknown_reason' },
      { stageCode: 2, processState: 'offer_accepted_pending_onboard' },
      { stageCode: 3, processState: 'completed' },
      { stageCode: null, processState: 'terminated_business' }
    ];
    return window.buildAnalysisMetricsForTest(rows);
  });
  const interview = metrics.stageRows[1];
  assert.equal(interview.reachedCount, 5);
  assert.equal(interview.advancedCount, 2);
  assert.equal(interview.realLossCount, 3);
  assert.equal(interview.businessTerminationCount, 1);
  assert.equal(interview.effectiveClosedCount, 5);
  assert.equal(interview.closedConversionRate, 40);
  assert.equal(interview.realLossRate, 60);
  assert.equal(metrics.summary.realLossCount, 4);
  assert.equal(metrics.summary.businessTerminationCount, 2);
  assert.equal(metrics.summary.unassignedTerminationCount, 1);
  assert.equal(metrics.summary.globalEffectiveClosedCount, 5);
  assert.equal(metrics.summary.globalRealLossRate, 80);
});

test('没有有效结案时比例返回 null 而不是 0', async () => {
  const row = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试']);
    return window.buildAnalysisMetricsForTest([
      { stageCode: 0, processState: 'in_progress' }
    ]).stageRows[0];
  });
  assert.equal(row.effectiveClosedCount, 0);
  assert.equal(row.closedConversionRate, null);
  assert.equal(row.realLossRate, null);
});

test('全部月份保留全部记录并让所有模块共用同一范围', async () => {
  const result = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', '入职']);
    const rows = [
      { candidateId: 'jan', stageCode: 0, processState: 'in_progress', resumeTime: '2026-01-10', qualityIssues: [] },
      { candidateId: 'feb', stageCode: 1, processState: 'terminated_business', resumeTime: '2026-02-10', qualityIssues: [] },
      { candidateId: 'missing', stageCode: 2, processState: 'completed', resumeTime: null, qualityIssues: ['missing_resume_time'] }
    ];
    const allMonths = window.buildAnalysisResultForTest(rows, {
      selectedJobs: [], timeMode: 'month', selectedMonth: '', selectedWeek: ''
    });
    const february = window.buildAnalysisResultForTest(rows, {
      selectedJobs: [], timeMode: 'month', selectedMonth: '2026-02', selectedWeek: ''
    });
    return {
      allCount: allMonths.rows.length,
      allSummary: allMonths.summary,
      funnelTotal: allMonths.stageRows[0].reachedCount,
      reportScope: allMonths.scopeLabel,
      detailCount: allMonths.candidateDetails.length,
      februaryIds: february.rows.map(row => row.candidateId),
      excludedMissingDateCount: february.quality.excludedMissingDateCount
    };
  });
  assert.equal(result.allCount, 3);
  assert.equal(result.allSummary.totalCandidates, 3);
  assert.equal(result.funnelTotal, 3);
  assert.equal(result.detailCount, 3);
  assert.match(result.reportScope, /全部月份/);
  assert.deepEqual(result.februaryIds, ['feb']);
  assert.equal(result.excludedMissingDateCount, 1);
});

test('刷新全部月份时顶端指标不回退到最近月份', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', '入职']);
    window.setRawDataForTest([
      { candidateId: 'jan', candidateName: '一月', stageCode: 0, stageName: '投递', status: 'in_progress', processState: 'in_progress', resumeTime: new Date('2026-01-10'), stageDates: {}, qualityIssues: [], unknownStage: false, unknownTerminated: false },
      { candidateId: 'feb', candidateName: '二月', stageCode: 1, stageName: '面试', status: 'terminated', processState: 'terminated_business', resumeTime: new Date('2026-02-10'), stageDates: {}, qualityIssues: [], unknownStage: false, unknownTerminated: false },
      { candidateId: 'missing', candidateName: '候选人缺日期', stageCode: 2, stageName: '入职', status: 'passed', processState: 'completed', resumeTime: null, stageDates: {}, qualityIssues: ['missing_resume_time'], unknownStage: false, unknownTerminated: false }
    ]);
    document.getElementById('timeDimension').value = 'month';
    document.getElementById('selectedMonth').value = '';
    refreshData();
    return {
      total: document.getElementById('statTotalCandidates').textContent.trim(),
      funnel: document.getElementById('funnelContainer').textContent
    };
  });
  assert.equal(output.total, '3');
  assert.match(output.funnel, /投递3/);
  assert.match(output.funnel, /100%/);
});

test('按阶段 SLA 识别进行中、待推进和 Offer 待入职风险', async () => {
  const result = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '面试', 'Offer', '入职']);
    const rows = [
      { candidateId: 'passed', stageCode: 1, processState: 'passed_pending_next', stageDates: { 1: '2026-08-01' }, stagePassDates: { 1: '2026-08-02' } },
      { candidateId: 'offer-overdue', stageCode: 2, processState: 'offer_accepted_pending_onboard', offerAcceptedDate: '2026-08-01', expectedOnboardDate: '2026-08-09' },
      { candidateId: 'offer-soon', stageCode: 2, processState: 'offer_accepted_pending_onboard', offerAcceptedDate: '2026-08-08', expectedOnboardDate: '2026-08-15' },
      { candidateId: 'missing-date', stageCode: 0, processState: 'in_progress', stageDates: {} },
      { candidateId: 'done', stageCode: 3, processState: 'completed', stageDates: { 3: '2026-08-01' } }
    ];
    return window.getAttentionCandidatesP0ForTest(rows, new Date('2026-08-10T12:00:00+08:00'));
  });
  assert.deepEqual(result.map(item => item.candidateId), [
    'offer-overdue', 'passed', 'offer-soon', 'missing-date'
  ]);
  assert.ok(result[0].tags.includes('逾期未入职'));
  assert.ok(result[1].tags.includes('当前阶段已通过、待安排下一阶段'));
  assert.ok(result[2].tags.includes('Offer已接受、待入职'));
  assert.ok(result[3].tags.includes('缺少阶段日期'));
  assert.equal(result.some(item => item.candidateId === 'done'), false);
});

test('无 Offer 阶段时关注页不出现 Offer 待入职分类', async () => {
  const tags = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', '审批', '入职']);
    return window.getAttentionCandidatesP0ForTest([{
      candidateId: 'approval',
      stageCode: 2,
      processState: 'passed_pending_next',
      offerAcceptedDate: '2026-08-01',
      stagePassDates: { 2: '2026-08-01' }
    }], new Date('2026-08-10T12:00:00+08:00'))[0].tags;
  });
  assert.equal(tags.includes('Offer已接受、待入职'), false);
});

test('Offer 已接受状态显示在需关注候选人页面', async () => {
  const boardText = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', 'Offer', '入职']);
    const rows = [{
      candidateId: 'offer-a',
      candidateName: '候选人Offer',
      jobName: '岗位A',
      stageCode: 2,
      stageName: 'Offer',
      status: 'passed',
      processState: 'offer_accepted_pending_onboard',
      offerAcceptedDate: new Date('2026-08-08'),
      expectedOnboardDate: new Date('2026-08-15'),
      stageDates: { 2: new Date('2026-08-08') },
      qualityIssues: []
    }];
    window.setRawDataForTest(rows);
    window.renderAttentionBoardForTest(rows);
    return document.getElementById('attentionBoardPage').textContent;
  });
  assert.match(boardText, /Offer已接受、待入职/);
});

test('主导航包含分析明细且 Offer 重点分类不在顶端指标', async () => {
  assert.deepEqual(
    await page.locator('.main-view-tab').allTextContents(),
    ['总览', '复盘分析', '分析明细', '需关注候选人']
  );
  await page.evaluate(() => {
    document.getElementById('mainContent').style.display = 'block';
    switchMainView('details');
  });
  assert.equal(await page.locator('#analysisDetailsPage').isVisible(), true);
  assert.deepEqual(await page.locator('[data-detail-tab]').allTextContents(), [
    '阶段分析', '候选人明细', '流失原因', '岗位', '渠道', '人选来源公司', '数据质量'
  ]);
  assert.equal(await page.locator('#detailsStagePanel').isVisible(), true);
  assert.equal(await page.locator('.stats-row').getByText('Offer已接受、待入职').count(), 0);
});

test('总览使用离线内联图标且模块标题图标语义一致', async () => {
  const output = await page.evaluate(() => ({
    brandIcon: document.querySelector('.app-brand .ui-icon')?.outerHTML || '',
    sectionIcons: Array.from(document.querySelectorAll('#reviewPage .dashboard-panel-title .ui-icon')).map(node => node.dataset.icon),
    helper: getUiIcon('trend')
  }));
  assert.match(output.brandIcon, /<svg/);
  assert.deepEqual(output.sectionIcons.slice(0, 5), ['funnel', 'clock', 'trend', 'reason', 'review']);
  assert.match(output.helper, /currentColor/);
  assert.doesNotMatch(output.helper, /https?:\/\//);
});

test('七项固定语义指标、纯漏斗与阶段招聘时效分别展示对应口径', async () => {
  const text = await page.evaluate(() => {
    const result = {
      summary: {
        totalCandidates: 10,
        inFlightCount: 3,
        completedCount: 2,
        overallConversionRate: 20,
        realLossCount: 5,
        globalRealLossRate: 71.4,
        businessTerminationCount: 2,
        unassignedTerminationCount: 1,
        slaOverdueCount: 1
      },
      rows: [],
      stageRows: [
        { code: 0, label: '投递', color: '#3B82F6', reachedCount: 10, inFlightCount: 2, advancedCount: 3, completedCount: 0, realLossCount: 5, businessTerminationCount: 2, passedPendingCount: 1, offerPendingCount: 0, inProgressCount: 1, closedConversionRate: 37.5, realLossRate: 62.5, avgStayDays: 2, slaOverdueCount: 1, effectiveClosedCount: 8 },
        { code: 1, label: '面试', color: '#10B981', reachedCount: 3, inFlightCount: 1, advancedCount: 2, completedCount: 0, realLossCount: 0, businessTerminationCount: 0, passedPendingCount: 1, offerPendingCount: 0, inProgressCount: 0, closedConversionRate: 100, realLossRate: 0, avgStayDays: 3, slaOverdueCount: 0, effectiveClosedCount: 2 }
      ]
    };
    window.renderP0OverviewForTest(result);
    return {
      stats: Array.from(document.querySelectorAll('.stats-row')).map(row => row.textContent).join(''),
      statCards: document.querySelectorAll('.stats-row .stat-card').length,
      funnel: document.querySelector('#funnelContainer').textContent,
      stageTiming: document.querySelector('#stageTimingCard').textContent
    };
  });
  assert.equal(text.statCards, 7);
  assert.match(text.stats, /招聘记录/);
  assert.match(text.stats, /Offer人数/);
  assert.match(text.stats, /入职人数/);
  assert.match(text.stats, /整体入职转化率/);
  assert.match(text.stats, /简历初筛通过率/);
  assert.match(text.stats, /一面→Offer转化率/);
  assert.match(text.stats, /Offer→入职转化率/);
  assert.doesNotMatch(text.stats, /Offer已接受、待入职/);
  assert.match(text.funnel, /投递10/);
  assert.match(text.funnel, /100%/);
  assert.match(text.funnel, /面试3\(30%\)/);
  assert.doesNotMatch(text.funnel, /推进|流失|在途|业务终止|SLA|原因/);
  assert.match(text.stageTiming, /阶段招聘时效/);
  assert.match(text.stageTiming, /阶段招聘时效/);
  assert.doesNotMatch(text.stageTiming, /真实流失率/);
});

test('分析明细保留业务终止子集和可核查原因', async () => {
  const result = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', '入职']);
    const rows = [
      { candidateId: 'a', candidateName: '候选人A', jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 1, processState: 'terminated_business', reasonClassification: { level1Category: '业务/HC', level2Reason: '岗位关闭', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false }, rawTerminationReason: '岗位关闭', qualityIssues: [] },
      { candidateId: 'b', candidateName: '候选人B', jobName: '岗位A', source: '渠道B', company: '公司B', stageCode: 1, processState: 'terminated_unknown_reason', reasonClassification: { level1Category: '原因未记录', level2Reason: '面试终止—具体原因未记录', confidence: 'low', matchSource: 'generic_reason', missingSpecificReason: true }, rawTerminationReason: '淘汰', qualityIssues: ['missing_specific_reason'] },
      { candidateId: 'c', candidateName: '候选人C', jobName: '岗位B', source: '渠道A', company: '公司A', stageCode: 2, processState: 'completed', reasonClassification: null, qualityIssues: [] }
    ];
    return window.buildAnalysisResultForTest(rows, {
      selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: ''
    });
  });
  assert.equal(result.reasonMatrix.find(row => row.level1Category === '业务/HC').count, 1);
  assert.equal(result.jobs.find(row => row.name === '岗位A').realLossCount, 2);
  assert.equal(result.jobs.find(row => row.name === '岗位A').businessTerminationCount, 1);
  assert.equal(result.candidateDetails.find(row => row.candidateId === 'b').confidence, 'low');
  assert.equal(result.quality.missingSpecificReasonCount, 0);
});

test('七个分析明细面板从同一结果对象渲染', async () => {
  const panels = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', '入职']);
    const rows = [
      { candidateId: 'a', candidateName: '候选人A', jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 1, processState: 'terminated_business', rawTerminationReason: '岗位关闭', reasonClassification: { level1Category: '业务/HC', level2Reason: '岗位关闭', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false }, qualityIssues: [] },
      { candidateId: 'b', candidateName: '候选人B', jobName: '岗位B', source: '渠道B', company: '公司B', stageCode: 2, processState: 'completed', qualityIssues: [] }
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    window.renderAnalysisDetailsForTest(result);
    return Object.fromEntries(Array.from(document.querySelectorAll('[data-detail-panel]')).map(panel => [panel.dataset.detailPanel, panel.textContent]));
  });
  assert.match(panels.stage, /阶段推进率/);
  assert.match(panels['stage-reason'], /岗位关闭/);
  assert.match(panels.jobs, /岗位A/);
  assert.match(panels.channels, /渠道A/);
  assert.match(panels.companies, /公司A/);
  assert.match(panels.candidates, /候选人A/);
  assert.match(panels.quality, /流失原因完整率/);
});

test('洞察必须同时给出结论、证据、动作和验证指标', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '面试', '入职']);
    const rows = [
      ...Array.from({ length: 4 }, (_, index) => ({
        candidateId: 'r' + index, candidateName: '招聘流失' + index, stageCode: 0,
        processState: 'terminated_recruitment',
        reasonClassification: { level1Category: '流程与体验', level2Reason: '流程太长', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false }
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        candidateId: 'b' + index, candidateName: '业务终止' + index, stageCode: 0,
        processState: 'terminated_business',
        reasonClassification: { level1Category: '业务/HC', level2Reason: '岗位关闭', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false }
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        candidateId: 'c' + index, candidateName: '完成' + index, stageCode: 2,
        processState: 'completed'
      }))
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    window.renderReviewInsightsForTest(result);
    return {
      insights: result.insights,
      overview: document.getElementById('reviewActionList').textContent,
      overviewCardCount: document.querySelectorAll('#reviewActionList .review-action-item').length,
      analysis: result.reviewAnalysis,
      summary: window.generateReviewSummaryForTest(result),
      report: window.generateReviewReportForTest(result)
    };
  });
  assert.ok(output.insights.length >= 1);
  output.insights.forEach(insight => {
    for (const field of ['id', 'title', 'conclusion', 'evidence', 'action', 'ownerSide', 'priority', 'validationMetrics', 'scope', 'confidence', 'limitations']) {
      assert.ok(Object.hasOwn(insight, field), `洞察缺少字段 ${field}`);
    }
    assert.ok(Array.isArray(insight.evidence) && insight.evidence.length > 0);
    assert.ok(Array.isArray(insight.validationMetrics) && insight.validationMetrics.length > 0);
  });
  assert.match(output.summary, /结论：/);
  assert.match(output.summary, /证据：/);
  assert.match(output.summary, /动作：/);
  assert.ok(output.analysis.findings.every(finding => finding.evidence.length && finding.furtherQuestions.length && finding.actions.length && finding.observationMetrics.length));
  assert.match(output.report, /二、本期招聘结果/);
  assert.match(output.report, /五、本期优先动作/);
  assert.match(output.report, /六、数据说明/);
  assert.match(output.overview, new RegExp(output.insights[0].conclusion));
  assert.match(output.summary, new RegExp(output.insights[0].title));
  assert.ok(output.overviewCardCount <= 6);
  assert.equal(new Set(output.insights.map(insight => insight.id)).size, output.insights.length);
  assert.doesNotMatch(output.overview, /\bP[012]\b|confidence|ownerSide|置信度|责任侧/);
});

test('小样本降级结论，业务终止归因给业务或HC', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '面试', '入职']);
    const rows = [
      { candidateId: 'a', stageCode: 0, processState: 'terminated_business', reasonClassification: { level1Category: '业务/HC', level2Reason: 'HC取消', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false } },
      { candidateId: 'b', stageCode: 0, processState: 'terminated_business', reasonClassification: { level1Category: '业务/HC', level2Reason: '岗位关闭', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false } },
      { candidateId: 'c', stageCode: 0, processState: 'terminated_unknown_reason', reasonClassification: { level1Category: '原因未记录', level2Reason: '简历评审终止—具体原因未记录', confidence: 'low', matchSource: 'generic_reason', missingSpecificReason: true } },
      { candidateId: 'd', stageCode: 2, processState: 'completed' }
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    return { insights: result.insights, businessCount: result.summary.businessTerminationCount, summary: window.generateReviewSummaryForTest(result) };
  });
  assert.ok(output.insights.every(insight => insight.confidence === 'low'));
  assert.ok(output.insights.every(insight => insight.limitations.length > 0));
  assert.equal(output.businessCount, 2);
  assert.match(output.summary, /样本较小/);
  assert.doesNotMatch(output.summary, /显著|严重|最差/);
});

test('全部月份与具体月份驱动卡片、漏斗、明细、关注页和报告同步变化', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '面试', 'Offer', '入职']);
    window.setRawDataForTest([
      { candidateId: 'jan', candidateName: '候选人A在途', jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 0, stageName: '投递', status: 'in_progress', processState: 'in_progress', resumeTime: new Date('2026-01-10'), stageDates: { 0: new Date('2026-01-10') }, stagePassDates: {}, qualityIssues: [] },
      { candidateId: 'feb', candidateName: '候选人B业务终止', jobName: '岗位A', source: '渠道B', company: '公司B', stageCode: 1, stageName: '面试', status: 'terminated', processState: 'terminated_business', resumeTime: new Date('2026-02-10'), stageDates: { 1: new Date('2026-02-10') }, stagePassDates: {}, reasonClassification: { level1Category: '业务/HC', level2Reason: '岗位关闭', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false }, qualityIssues: [] },
      { candidateId: 'missing', candidateName: '候选人缺日期已入职', jobName: '岗位B', source: '渠道A', company: '公司A', stageCode: 3, stageName: '入职', status: 'passed', processState: 'completed', resumeTime: null, stageDates: {}, stagePassDates: {}, qualityIssues: ['missing_resume_time'] },
      { candidateId: 'aug', candidateName: '候选人C待入职', jobName: '岗位B', source: '渠道B', company: '公司B', stageCode: 2, stageName: 'Offer', status: 'passed', processState: 'offer_accepted_pending_onboard', resumeTime: new Date('2026-08-03'), stageDates: { 2: new Date('2026-08-04') }, stagePassDates: { 2: new Date('2026-08-05') }, offerAcceptedDate: new Date('2026-08-05'), expectedOnboardDate: new Date('2026-08-15'), qualityIssues: [] }
    ]);
    document.getElementById('timeDimension').value = 'month';
    document.getElementById('selectedMonth').innerHTML = '<option value="">全部月份</option><option value="2026-08">2026-08</option>';
    document.getElementById('selectedMonth').value = '';
    switchMainView('review');
    refreshData();
    switchMainView('details');
    switchDetailView('candidates');
    switchMainView('reviewAnalysis');
    const all = {
      total: document.getElementById('statTotalCandidates').textContent.trim(),
      funnel: document.getElementById('funnelContainer').textContent,
      detailRows: document.querySelectorAll('#candidateDetailTable tbody tr').length,
      attention: document.getElementById('attentionBoardPage').textContent,
      report: window.generateReviewReportForTest(currentAnalysisResult),
      month: document.getElementById('selectedMonth').value
    };
    switchMainView('attention');
    const preservedMonth = document.getElementById('selectedMonth').value;
    document.getElementById('selectedMonth').value = '2026-08';
    refreshData();
    switchMainView('review');
    switchMainView('details');
    switchDetailView('candidates');
    switchMainView('reviewAnalysis');
    const august = {
      total: document.getElementById('statTotalCandidates').textContent.trim(),
      detailRows: document.querySelectorAll('#candidateDetailTable tbody tr').length,
      report: window.generateReviewReportForTest(currentAnalysisResult)
    };
    return { all, august, preservedMonth };
  });
  assert.equal(output.all.total, '4');
  assert.match(output.all.funnel, /投递4/);
  assert.match(output.all.funnel, /100%/);
  assert.equal(output.all.detailRows, 4);
  assert.match(output.all.attention, /Offer已接受、待入职/);
  assert.match(output.all.report, /4条招聘记录/);
  assert.equal(output.all.month, '');
  assert.equal(output.preservedMonth, '');
  assert.equal(output.august.total, '1');
  assert.equal(output.august.detailRows, 1);
  assert.match(output.august.report, /时间：2026-08/);
  assert.match(output.august.report, /招聘记录：1条/);
});

test('自定义阶段和终止原因按文本渲染，不创建注入节点', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['<img data-injected src=x>', 'Offer', '入职']);
    const rows = [{
      candidateId: 'unsafe', candidateName: '安全测试', stageCode: 0,
      processState: 'terminated_recruitment',
      rawTerminationReason: '<img data-reason src=x>',
      reasonClassification: { level1Category: '流程与体验', level2Reason: '<img data-reason src=x>', confidence: 'high', matchSource: 'explicit_reason', missingSpecificReason: false }
    }];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    window.renderP0OverviewForTest(result);
    window.renderAnalysisDetailsForTest(result);
    return {
      injectedNodes: document.querySelectorAll('img[data-injected], img[data-reason]').length,
      overviewText: document.getElementById('funnelContainer').textContent,
      detailText: document.getElementById('detailsStageReasonPanel').textContent
    };
  });
  assert.equal(output.injectedNodes, 0);
  assert.match(output.overviewText, /<img data-injected src=x>/);
  assert.match(output.detailText, /<img data-reason src=x>/);
});

test('四个一级页面使用独立容器且刷新不改变当前页面', async () => {
  const output = await page.evaluate(() => {
    document.getElementById('mainContent').classList.add('active');
    window.setRawDataForTest([]);
    switchMainView('details');
    refreshData();
    const pageIds = ['reviewPage', 'reviewAnalysisPage', 'detailsPage', 'attentionPage'];
    const afterDetailsRefresh = pageIds.map(id => ({
      id,
      hidden: document.getElementById(id)?.hidden
    }));
    switchMainView('attention');
    refreshData();
    const afterAttentionRefresh = pageIds.map(id => ({
      id,
      hidden: document.getElementById(id)?.hidden
    }));
    return {
      afterDetailsRefresh,
      afterAttentionRefresh,
      afterReviewAnalysisRefresh: (() => { switchMainView('reviewAnalysis'); refreshData(); return pageIds.map(id => ({ id, hidden: document.getElementById(id)?.hidden })); })(),
      legacyVisibilityFunctions: [typeof applyMainViewVisibility, typeof setAnalysisSectionsVisible]
    };
  });
  assert.deepEqual(output.afterDetailsRefresh, [
    { id: 'reviewPage', hidden: true },
    { id: 'reviewAnalysisPage', hidden: true },
    { id: 'detailsPage', hidden: false },
    { id: 'attentionPage', hidden: true }
  ]);
  assert.deepEqual(output.afterAttentionRefresh, [
    { id: 'reviewPage', hidden: true },
    { id: 'reviewAnalysisPage', hidden: true },
    { id: 'detailsPage', hidden: true },
    { id: 'attentionPage', hidden: false }
  ]);
  assert.deepEqual(output.afterReviewAnalysisRefresh, [
    { id: 'reviewPage', hidden: true },
    { id: 'reviewAnalysisPage', hidden: false },
    { id: 'detailsPage', hidden: true },
    { id: 'attentionPage', hidden: true }
  ]);
  assert.deepEqual(output.legacyVisibilityFunctions, ['undefined', 'undefined']);
});

test('固定语义 KPI 使用累计到达口径且歧义阶段返回不可计算', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const rows = [
      ...Array.from({ length: 4 }, (_, index) => ({ candidateId: 'resume-' + index, stageCode: 0, processState: 'terminated_recruitment' })),
      ...Array.from({ length: 3 }, (_, index) => ({ candidateId: 'phone-' + index, stageCode: 1, processState: 'terminated_recruitment' })),
      ...Array.from({ length: 2 }, (_, index) => ({ candidateId: 'interview-' + index, stageCode: 2, processState: 'terminated_recruitment' })),
      { candidateId: 'offer', stageCode: 3, processState: 'offer_accepted_pending_onboard' },
      { candidateId: 'onboard', stageCode: 4, processState: 'completed' }
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    const kpis = result.businessKpis;
    window.setCurrentStagesForTest(['简历评审', '初筛', '电话联系', '一面', 'Offer', '入职']);
    const ambiguous = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' }).businessKpis;
    window.setCurrentStagesForTest(['投递', '电话联系', '一面', 'Offer', '入职']);
    const positionalOnly = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' }).businessKpis;
    return { kpis, ambiguous, positionalOnly };
  });
  assert.equal(output.kpis.totalRecords.value, 11);
  assert.deepEqual([output.kpis.resumeScreenPassRate.numerator, output.kpis.resumeScreenPassRate.denominator], [7, 11]);
  assert.deepEqual([output.kpis.firstInterviewToOfferRate.numerator, output.kpis.firstInterviewToOfferRate.denominator], [2, 4]);
  assert.deepEqual([output.kpis.offerToOnboardRate.numerator, output.kpis.offerToOnboardRate.denominator], [1, 2]);
  assert.equal(output.ambiguous.resumeScreenPassRate.available, false);
  assert.match(output.ambiguous.resumeScreenPassRate.unavailableReason, /无法唯一识别/);
  assert.equal(output.positionalOnly.resumeScreenPassRate.available, false);
});

test('历史耗时寻找 next applicable stage 并使用固定覆盖率分母', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['投递', '笔试', '技术面', '终面', '入职']);
    const rows = [
      {
        candidateId: 'skip-valid', stageCode: 4, status: 'passed', processState: 'completed',
        stageDates: { 0: new Date('2026-08-01'), 2: new Date('2026-08-05'), 4: new Date('2026-08-10') }, stagePassDates: {}
      },
      {
        candidateId: 'advanced-missing-end', stageCode: 2, status: 'in_progress', processState: 'in_progress',
        stageDates: { 0: new Date('2026-08-01') }, stagePassDates: {}
      },
      {
        candidateId: 'invalid-start', stageCode: 4, status: 'passed', processState: 'completed',
        stageDates: { 0: '无法解析', 2: new Date('2026-08-06'), 4: new Date('2026-08-09') }, stagePassDates: {}
      },
      {
        candidateId: 'stay-valid', stageCode: 2, status: 'in_progress', processState: 'in_progress',
        stageDates: { 2: new Date('2026-08-08') }, stagePassDates: {}
      },
      {
        candidateId: 'stay-missing', stageCode: 2, status: 'in_progress', processState: 'in_progress',
        stageDates: {}, stagePassDates: {}
      }
    ];
    return window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' }, new Date('2026-08-10T12:00:00+08:00')).stageRows;
  });
  assert.equal(output[0].transitionTimeStats.averageDays, 4);
  assert.equal(output[0].transitionTimeStats.validSampleCount, 1);
  assert.equal(output[0].transitionTimeStats.eligibleCount, 3);
  assert.equal(output[0].transitionTimeStats.coverageRate, 33.3);
  assert.equal(output[1].transitionTimeStats.eligibleCount, 0);
  assert.equal(output[2].currentStayStats.validSampleCount, 2);
  assert.equal(output[2].currentStayStats.eligibleCount, 3);
  assert.equal(output[2].currentStayStats.coverageRate, 66.7);
  assert.equal(output[2].currentStayStats.estimatedSampleCount, 1);
});

test('复盘组件使用单漏斗、分组阶段表和可关闭信息弹层', async () => {
  const output = await page.evaluate(async () => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const rows = [
      { candidateId: 'a', stageCode: 0, status: 'terminated', processState: 'terminated_recruitment', stageDates: { 0: new Date('2026-08-01') }, stagePassDates: {} },
      { candidateId: 'b', stageCode: 4, status: 'passed', processState: 'completed', stageDates: { 0: new Date('2026-08-01'), 1: new Date('2026-08-02'), 2: new Date('2026-08-03'), 3: new Date('2026-08-04'), 4: new Date('2026-08-05') }, stagePassDates: {} }
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    switchMainView('review');
    window.renderP0OverviewForTest(result);
    const trigger = document.querySelector('#reviewPage .info-trigger');
    trigger.click();
    const opened = !document.getElementById('infoPopover').hidden;
    trigger.click();
    const repeatedClosed = document.getElementById('infoPopover').hidden && document.activeElement === trigger;
    trigger.click();
    document.body.click();
    const outsideClosed = document.getElementById('infoPopover').hidden && document.activeElement === trigger;
    trigger.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return {
      funnelRows: document.querySelectorAll('#funnelContainer .funnel-row').length,
      funnelText: document.getElementById('funnelContainer').textContent,
      timingRows: document.querySelectorAll('#stageTimingList .stage-timing-row').length,
      timingText: document.getElementById('stageTimingCard').textContent,
      opened,
      repeatedClosed,
      outsideClosed,
      closed: document.getElementById('infoPopover').hidden,
      focusReturned: document.activeElement === trigger
    };
  });
  assert.equal(output.funnelRows, 5);
  assert.doesNotMatch(output.funnelText, /推进|流失|在途/);
  assert.ok(output.timingRows > 0);
  assert.doesNotMatch(output.timingText, /查看明细|其中业务终止/);
  assert.equal(output.opened, true);
  assert.equal(output.repeatedClosed, true);
  assert.equal(output.outsideClosed, true);
  assert.equal(output.closed, true);
  assert.equal(output.focusReturned, true);
});

test('复盘报告与复盘分析页面使用同一结构化结果', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const rows = [{ candidateId: 'done', stageCode: 4, processState: 'completed' }];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    return {
      report: window.generateReviewReportForTest(result),
      persistentPreview: Boolean(document.getElementById('reportPreviewCard')),
      globalExportButton: Array.from(document.querySelectorAll('.actions-bar button')).some(button => button.textContent.includes('导出报告'))
    };
  });
  for (const section of ['复盘范围', '本期招聘结果', '重点复盘分析', '当前流程关注', '本期优先动作', '数据说明']) {
    assert.match(output.report, new RegExp(section));
  }
  assert.equal(output.persistentPreview, false);
  assert.equal(output.globalExportButton, false);
});

test('漏斗在大样本与极小样本下保持固定三列边界', async () => {
  const positions = await page.evaluate(() => {
    switchMainView('review');
    window.renderP0OverviewForTest({
      summary: { totalCandidates: 100, completedCount: 1 },
      rows: [],
      stageRows: [
        { code: 0, label: '简历评审', color: '#3B82F6', reachedCount: 100 },
        { code: 1, label: '一面', color: '#10B981', reachedCount: 1 }
      ]
    });
    return Array.from(document.querySelectorAll('#funnelContainer .funnel-row')).map(row => {
      const [label, track, value] = Array.from(row.children).map(element => element.getBoundingClientRect());
      return { labelLeft: label.left, trackLeft: track.left, valueLeft: value.left, fillWidth: row.querySelector('.funnel-fill').getBoundingClientRect().width };
    });
  });
  assert.equal(positions.length, 2);
  for (const key of ['labelLeft', 'trackLeft', 'valueLeft']) assert.ok(Math.abs(positions[0][key] - positions[1][key]) < 0.5);
  assert.ok(positions[1].fillWidth >= 4);
});

test('趋势使用期间整体真实流失率、pct差值并跳过不可识别序列', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const rows = [
      ...Array.from({ length: 2 }, (_, index) => ({ candidateId: 'jan-done-' + index, resumeTime: new Date('2026-01-05'), stageCode: 4, processState: 'completed' })),
      ...Array.from({ length: 2 }, (_, index) => ({ candidateId: 'jan-loss-' + index, resumeTime: new Date('2026-01-06'), stageCode: 1, processState: 'terminated_recruitment' })),
      { candidateId: 'feb-done', resumeTime: new Date('2026-02-05'), stageCode: 4, processState: 'completed' },
      ...Array.from({ length: 3 }, (_, index) => ({ candidateId: 'feb-loss-' + index, resumeTime: new Date('2026-02-06'), stageCode: 3, processState: 'terminated_recruitment' }))
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'month', selectedMonth: '2026-02', selectedWeek: '' });
    switchMainView('review');
    window.renderReviewPageForTest(result);
    const globalLossChange = result.trend.comparison.changes.find(change => change.key === 'globalRealLossRate');
    const trendHidden = document.getElementById('reviewTrendPanel').hidden;
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '录用', '入职']);
    const ambiguous = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'month', selectedMonth: '2026-02', selectedWeek: '' });
    return {
      series: result.trend.series.map(series => series.label),
      globalLossChange,
      trendHidden,
      ambiguousSeries: ambiguous.trend.series.map(series => series.label),
      offerAvailable: ambiguous.businessKpis.offerCount.available
    };
  });
  assert.deepEqual(output.series, ['招聘记录', '一面', 'Offer', '入职']);
  assert.deepEqual(output.globalLossChange, { key: 'globalRealLossRate', label: '整体真实流失率', value: 25, unit: 'pct' });
  assert.equal(output.trendHidden, false);
  assert.equal(output.ambiguousSeries.includes('Offer'), false);
  assert.equal(output.offerAvailable, false);
});

test('阶段钻取筛选独立于岗位与时间筛选并可显式清除', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    window.setRawDataForTest([
      { candidateId: 'loss', candidateName: '流失候选人', jobName: '产品', resumeTime: new Date('2026-08-05'), stageCode: 2, processState: 'terminated_recruitment', reasonClassification: { level1Category: '匹配与评估', level2Reason: '经验不符', controllability: '业务侧可控', missingSpecificReason: false } },
      { candidateId: 'done', candidateName: '入职候选人', jobName: '产品', resumeTime: new Date('2026-08-06'), stageCode: 4, processState: 'completed' }
    ]);
    document.getElementById('timeDimension').value = 'month';
    document.getElementById('selectedMonth').innerHTML = '<option value="2026-08">2026-08</option>';
    document.getElementById('selectedMonth').value = '2026-08';
    switchMainView('review');
    refreshData();
    navigateToDetails('stage-reason', { stageCode: 2 });
    const drilled = {
      month: document.getElementById('selectedMonth').value,
      chip: document.getElementById('detailsDrilldownFilters').textContent,
      rows: document.querySelectorAll('#detailsStageReasonPanel tbody tr').length
    };
    clearDetailFilters();
    return {
      drilled,
      monthAfterClear: document.getElementById('selectedMonth').value,
      filterHidden: document.getElementById('detailsDrilldownFilters').hidden
    };
  });
  assert.equal(output.drilled.month, '2026-08');
  assert.match(output.drilled.chip, /来自复盘证据/);
  assert.equal(output.drilled.rows, 1);
  assert.equal(output.monthAfterClear, '2026-08');
  assert.equal(output.filterHidden, true);
});

test('移动端驾驶舱保持页面不横向溢出', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => {
    switchMainView('review');
    return {
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      timingVisible: !document.getElementById('stageTimingCard').hidden
    };
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.ok(dimensions.pageScrollWidth <= dimensions.pageClientWidth + 1);
  assert.equal(dimensions.timingVisible, true);
});

test('入职 KPI 仅统计真正完成，Offer 待入职不走普通阶段 SLA', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: '2026-08-01', stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    window.makeCandidate = candidate;
    const rows = [
      candidate({ candidateId: 'completed', stageCode: 3, status: 'passed', processState: 'completed' }),
      candidate({ candidateId: 'final-loss', stageCode: 3, status: 'terminated', processState: 'terminated_recruitment', rawTerminationReason: '淘汰（面试/评审不通过）' }),
      candidate({ candidateId: 'offer-pending', stageCode: 2, status: 'passed', processState: 'offer_accepted_pending_onboard', offerAcceptedDate: '2026-08-01', stageDates: { 2: '2026-07-01' }, expectedOnboardDate: '2026-08-20' })
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' }, new Date('2026-08-10T12:00:00+08:00'));
    const offerPending = window.enrichCandidateRecordForTest(rows[2]);
    return {
      onboard: result.businessKpis.onboardCount,
      overall: result.businessKpis.overallOnboardRate,
      offerToOnboard: result.businessKpis.offerToOnboardRate,
      sla: window.getCandidateSlaStateForTest(offerPending, new Date('2026-08-10T12:00:00+08:00'))
    };
  });
  assert.equal(output.onboard.value, 1);
  assert.equal(output.onboard.numerator, 1);
  assert.equal(output.overall.value, 33.3);
  assert.equal(output.offerToOnboard.value, 33.3);
  assert.equal(output.sla.state, 'not_applicable');
});

test('阶段×原因按原始终止原因汇总，不按备注拆分', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: '2026-08-01', stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    const result = window.buildAnalysisResultForTest([
      candidate({ candidateId: 'plain', stageCode: 1, status: 'terminated', rawTerminationReason: '淘汰（面试/评审不通过）', rawRemark: '' }),
      candidate({ candidateId: 'remark', stageCode: 1, status: 'terminated', rawTerminationReason: '淘汰（面试/评审不通过）', rawRemark: '支付经验不足' }),
      candidate({ candidateId: 'blank', stageCode: 1, status: 'terminated', rawTerminationReason: '', rawRemark: '' }),
      candidate({ candidateId: 'hc', stageCode: 1, status: 'terminated', rawTerminationReason: 'hc原因', rawRemark: '' })
    ], { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    return {
      matrix: result.reasonMatrix.map(row => ({ reason: row.terminationReason, count: row.count })),
      hcState: result.rows.find(row => row.candidateId === 'hc').processState
    };
  });
  assert.equal(output.matrix.filter(row => row.reason === '淘汰（面试/评审不通过）').length, 1);
  assert.equal(output.matrix.find(row => row.reason === '淘汰（面试/评审不通过）')?.count, 2);
  assert.ok(output.matrix.some(row => row.reason === '原因未记录'));
  assert.equal(output.hcState, 'terminated_business');
});

test('驾驶舱阶段时效、复盘和 Attention preview 使用精简业务结构', async () => {
  const output = await page.evaluate(() => {
    const result = window.buildAnalysisResultForTest([
      makeCandidate({ candidateId: 'loss', stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' }),
      makeCandidate({ candidateId: 'active', stageCode: 1, status: 'in_progress', stageDates: { 1: '2026-08-01' } })
    ], { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    switchMainView('review');
    window.renderReviewPageForTest(result);
    return {
      timingPanel: document.getElementById('stageTimingCard')?.textContent || '',
      reviewText: document.getElementById('reviewActionList')?.textContent || '',
      attentionPreview: document.getElementById('attentionPreview')?.textContent || '',
      hasLegacyDiagnostics: Boolean(document.getElementById('reviewSidePanel')),
      hasLegacyStageTable: Boolean(document.getElementById('stageAnalysisCard'))
    };
  });
  assert.match(output.timingPanel, /阶段招聘时效/);
  assert.match(output.reviewText, /建议动作/);
  assert.match(output.reviewText, /后续关注/);
  assert.match(output.attentionPreview, /需关注候选人/);
  assert.equal(output.hasLegacyDiagnostics, false);
  assert.equal(output.hasLegacyStageTable, false);
});

test('首页按招聘驾驶舱参考布局展示阶段招聘时效，而不是阶段大表', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const result = {
      summary: { totalCandidates: 12, completedCount: 1, inFlightCount: 2 },
      rows: [],
      businessKpis: {},
      insights: [],
      attentionCandidates: [],
      stageRows: [
        { code: 0, label: '简历评审', reachedCount: 12, transitionTimeStats: { averageDays: 7, medianDays: 6, validSampleCount: 4, eligibleCount: 5, coverageRate: 80 } },
        { code: 2, label: '一面', reachedCount: 8, transitionTimeStats: { averageDays: 2.3, medianDays: 2, validSampleCount: 3, eligibleCount: 4, coverageRate: 75 } },
        { code: 3, label: 'Offer', reachedCount: 2, transitionTimeStats: { averageDays: null, medianDays: null, validSampleCount: 0, eligibleCount: 0, coverageRate: null } }
      ]
    };
    switchMainView('review');
    window.renderReviewPageForTest(result);
    return {
      timingPanel: Boolean(document.getElementById('stageTimingCard')),
      timingRows: Array.from(document.querySelectorAll('#stageTimingList .stage-timing-row')).map(row => row.textContent.trim()),
      timingBars: document.querySelectorAll('#stageTimingList .stage-timing-fill').length,
      legacyStageTable: Boolean(document.getElementById('stageAnalysisCard'))
    };
  });
  assert.equal(output.timingPanel, true);
  assert.deepEqual(output.timingRows, ['简历评审→电话联系7.0天', '一面→Offer2.3天']);
  assert.equal(output.timingBars, 2);
  assert.equal(output.legacyStageTable, false);
});

test('首页视觉表达与最终示意图对齐且不复用趋势三栏', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const result = {
      summary: { totalCandidates: 479, completedCount: 4, inFlightCount: 9 },
      rows: [], businessKpis: {}, insights: [{ conclusion: '当前阶段值得继续关注。', action: '进入明细核查。', evidence: [{ value: '2 条', detail: '当前范围证据。' }], validationMetrics: ['阶段推进率'] }], attentionCandidates: [{ candidateName: '候选人A', stageCode: 0, processState: 'in_progress', slaState: 'within', tags: [{ label: '进行中', tone: 'low' }] }],
      stageRows: [
        { code: 0, label: '简历评审', reachedCount: 479, transitionTimeStats: { averageDays: 7 } },
        { code: 1, label: '电话联系', reachedCount: 335, transitionTimeStats: { averageDays: 2 } },
        { code: 2, label: '一面', reachedCount: 203, transitionTimeStats: { averageDays: 5 } },
        { code: 3, label: 'Offer', reachedCount: 6, transitionTimeStats: { averageDays: 1 } },
        { code: 4, label: '入职', reachedCount: 4, transitionTimeStats: { averageDays: null } }
      ]
    };
    switchMainView('review');
    window.renderReviewPageForTest(result);
    return {
      gridColumns: getComputedStyle(document.querySelector('.dashboard-primary-grid')).gridTemplateColumns,
      timingRows: Array.from(document.querySelectorAll('#stageTimingList .stage-timing-row')).map(row => row.textContent.trim()),
      barColors: Array.from(document.querySelectorAll('#funnelContainer .funnel-fill')).map(el => el.style.backgroundColor || el.style.background),
      timingColors: Array.from(document.querySelectorAll('#stageTimingList .stage-timing-fill')).map(el => el.style.backgroundColor || el.style.background),
      funnelText: document.getElementById('funnelContainer').textContent,
      actionIndex: document.querySelector('.review-action-index')?.textContent || '',
      actionIndexStyle: getComputedStyle(document.querySelector('.review-action-index')).backgroundColor,
      attentionPillBorder: getComputedStyle(document.querySelector('.attention-preview-stat')).borderStyle,
      headingHidden: !document.querySelector('.review-heading'),
      entryVisible: Boolean(document.querySelector('.review-analysis-link'))
    };
  });
  assert.match(output.gridColumns, /\d+px\s+\d+px/);
  assert.equal(output.timingRows.length, 4);
  assert.equal(output.barColors[0], output.timingColors[0]);
  assert.match(output.funnelText, /↓\s*69\.9%/);
  assert.equal(output.actionIndex, '01');
  assert.equal(output.actionIndexStyle, 'rgba(0, 0, 0, 0)');
  assert.equal(output.attentionPillBorder, 'none');
  assert.equal(output.headingHidden, true);
  assert.equal(output.entryVisible, true);
});

test('复盘分析复用当前结果，首页入口与证据钻取保持全局筛选', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: new Date('2026-08-01'), stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    window.setRawDataForTest([
      ...Array.from({ length: 3 }, (_, index) => candidate({ candidateId: 'phone-' + index, stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' })),
      ...Array.from({ length: 4 }, (_, index) => candidate({ candidateId: 'interview-' + index, stageCode: 2, status: 'terminated', rawTerminationReason: '淘汰（面试/评审不通过）' })),
      candidate({ candidateId: 'overdue', stageCode: 2, status: 'in_progress', stageDates: { 2: new Date('2026-07-20') } }),
      candidate({ candidateId: 'done', stageCode: 4, status: 'passed', stageDates: { 0: new Date('2026-08-01'), 1: new Date('2026-08-02'), 2: new Date('2026-08-03'), 3: new Date('2026-08-04'), 4: new Date('2026-08-05') } })
    ]);
    document.getElementById('timeDimension').value = 'overall';
    document.getElementById('jobSelect').value = '';
    refreshData();
    switchMainView('review');
    document.querySelector('#reviewPage .review-action-panel .review-analysis-link').click();
    const analysisOpened = !document.getElementById('reviewAnalysisPage').hidden;
    const reportBefore = window.generateReviewReportForTest(currentAnalysisResult);
    const firstFinding = currentAnalysisResult.reviewAnalysis.findings[0];
    const stageEvidence = Array.from(document.querySelectorAll('#reviewAnalysisFindings [data-review-evidence]')).find(button => JSON.parse(button.dataset.reviewEvidence).filters?.stageCode === 1);
    stageEvidence?.click();
    const detailsDrill = { active: !document.getElementById('detailsPage').hidden, tab: document.querySelector('.detail-view-tab.active')?.dataset.detailTab, stage: document.getElementById('stageAnalysisStageFilter')?.value, mode: document.getElementById('timeDimension').value, job: document.getElementById('jobSelect').value };
    switchMainView('reviewAnalysis');
    const slaEvidence = Array.from(document.querySelectorAll('#reviewAnalysisFindings [data-review-evidence]')).find(button => JSON.parse(button.dataset.reviewEvidence).page === 'attention');
    slaEvidence?.click();
    return {
      analysisOpened,
      firstFinding,
      reportBefore,
      detailsDrill,
      attentionOpened: !document.getElementById('attentionPage').hidden,
      attentionChip: document.getElementById('attentionDrilldownFilters').textContent
    };
  });
  assert.equal(output.analysisOpened, true);
  assert.ok(output.firstFinding.evidence.length && output.firstFinding.furtherQuestions.length && output.firstFinding.actions.length && output.firstFinding.observationMetrics.length);
  assert.match(output.reportBefore, new RegExp(output.firstFinding.conclusion));
  assert.equal(output.detailsDrill.active, true);
  assert.equal(output.detailsDrill.tab, 'stage');
  assert.equal(output.detailsDrill.stage, '1');
  assert.equal(output.detailsDrill.mode, 'overall');
  assert.equal(output.detailsDrill.job, '');
  assert.equal(output.attentionOpened, true);
  assert.match(output.attentionChip, /超 SLA/);
});

test('复盘分析以工作台呈现结构化复盘、流程关注和同源报告', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: new Date('2026-08-01'), stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    window.setRawDataForTest([
      ...Array.from({ length: 8 }, (_, index) => candidate({ candidateId: 'phone-intent-' + index, stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' })),
      ...Array.from({ length: 3 }, (_, index) => candidate({ candidateId: 'phone-unreachable-' + index, stageCode: 1, status: 'terminated', rawTerminationReason: '联系不上' })),
      ...Array.from({ length: 9 }, (_, index) => candidate({ candidateId: 'first-' + index, stageCode: 2, status: 'terminated', rawTerminationReason: '淘汰（面试/评审不通过）' })),
      candidate({ candidateId: 'overdue', stageCode: 2, status: 'in_progress', stageDates: { 2: new Date('2026-07-20') } }),
      candidate({ candidateId: 'offer-pending', stageCode: 3, status: 'offer_accepted_pending_onboard', expectedOnboardDate: new Date('2026-08-20') }),
      candidate({ candidateId: 'done', stageCode: 4, status: 'passed', stageDates: { 0: new Date('2026-08-01'), 1: new Date('2026-08-02'), 2: new Date('2026-08-03'), 3: new Date('2026-08-04'), 4: new Date('2026-08-05') } })
    ]);
    document.getElementById('timeDimension').value = 'overall';
    refreshData();
    switchMainView('reviewAnalysis');
    const report = window.generateReviewReportForTest(currentAnalysisResult);
    const model = currentAnalysisResult.reviewAnalysis;
    return {
      layout: Boolean(document.querySelector('.review-analysis-workspace')),
      summaryIsCard: Boolean(document.querySelector('.review-analysis-summary.card')),
      findingCount: document.querySelectorAll('#reviewAnalysisFindings .review-analysis-finding').length,
      sidebarSections: ['reviewAnalysisPriorityActions', 'reviewAnalysisCurrentRisks', 'reviewAnalysisDataLimitations'].map(id => Boolean(document.getElementById(id))),
      titles: model.findings.map(item => item.conclusion),
      phoneEvidence: model.findings.find(item => item.id === 'phone-contact-loss')?.evidence || [],
      report,
      reportSummary: model.executiveSummary,
      badTerms: document.getElementById('reviewAnalysisContent').textContent.match(/评估损耗环节|前端画像失配|负责人|形成闭环/g) || []
    };
  });
  assert.equal(output.layout, true);
  assert.equal(output.summaryIsCard, false);
  assert.ok(output.findingCount >= 3 && output.findingCount <= 5);
  assert.deepEqual(output.sidebarSections, [true, true, true]);
  assert.ok(output.titles.every(title => !/评估损耗环节|前端画像失配|负责人/.test(title)));
  assert.ok(output.phoneEvidence.some(item => /不看机会\/无意向/.test(item.detail || '') && item.navigation?.filters?.terminationReason === '不看机会/无意向'));
  assert.ok(output.reportSummary.every(line => output.report.includes(line)));
  assert.deepEqual(output.badTerms, []);
});

test('复盘分析证据通过临时筛选进入原始原因、关注页与数据质量', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: new Date('2026-08-01'), stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    window.setRawDataForTest([
      ...Array.from({ length: 5 }, (_, index) => candidate({ candidateId: 'phone-' + index, stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' })),
      ...Array.from({ length: 5 }, (_, index) => candidate({ candidateId: 'first-' + index, stageCode: 2, status: 'terminated', rawTerminationReason: '淘汰（面试/评审不通过）' })),
      candidate({ candidateId: 'overdue', stageCode: 2, status: 'in_progress', stageDates: { 2: new Date('2026-07-20') } }),
      candidate({ candidateId: 'missing-date', stageCode: 1, status: 'in_progress', stageDates: {} })
    ]);
    document.getElementById('timeDimension').value = 'overall';
    document.getElementById('jobSelect').value = '';
    refreshData();
    switchMainView('reviewAnalysis');
    const reasonButton = Array.from(document.querySelectorAll('#reviewAnalysisFindings [data-review-evidence]')).find(button => JSON.parse(button.dataset.reviewEvidence).filters?.terminationReason === '不看机会/无意向');
    reasonButton?.click();
    const reasonDrill = { page: !document.getElementById('detailsPage').hidden, chip: document.getElementById('detailsDrilldownFilters').textContent, stage: document.getElementById('stageReasonStageFilter')?.value, reason: document.getElementById('stageReasonReasonFilter')?.value, mode: document.getElementById('timeDimension').value, job: document.getElementById('jobSelect').value };
    switchMainView('reviewAnalysis');
    const slaButton = Array.from(document.querySelectorAll('#reviewAnalysisFindings [data-review-evidence]')).find(button => JSON.parse(button.dataset.reviewEvidence).filters?.slaState === 'overdue');
    slaButton?.click();
    const slaDrill = { page: !document.getElementById('attentionPage').hidden, chip: document.getElementById('attentionDrilldownFilters').textContent };
    switchMainView('reviewAnalysis');
    const qualityButton = document.querySelector('#reviewAnalysisDataLimitations [data-review-evidence]');
    qualityButton?.click();
    return { reasonDrill, slaDrill, qualityPage: !document.getElementById('detailsPage').hidden, qualityTab: document.querySelector('[data-detail-tab="quality"]')?.classList.contains('active') };
  });
  assert.equal(output.reasonDrill.page, true);
  assert.equal(output.reasonDrill.stage, '1');
  assert.equal(output.reasonDrill.reason, '不看机会/无意向');
  assert.equal(output.reasonDrill.mode, 'overall');
  assert.equal(output.reasonDrill.job, '');
  assert.equal(output.slaDrill.page, true);
  assert.match(output.slaDrill.chip, /超 SLA/);
  assert.equal(output.qualityPage, true);
  assert.equal(output.qualityTab, true);
});

test('复盘分析在宽屏与移动端保持工作台和无页面横向溢出', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktop = await page.evaluate(() => {
    switchMainView('reviewAnalysis');
    const workspace = document.querySelector('.review-analysis-workspace');
    return {
      columns: getComputedStyle(workspace).gridTemplateColumns,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const workspace = document.querySelector('.review-analysis-workspace');
    return {
      columns: getComputedStyle(workspace).gridTemplateColumns,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      visible: !document.getElementById('reviewAnalysisPage').hidden
    };
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  const compactDesktop = await page.evaluate(() => ({
    columns: getComputedStyle(document.querySelector('.review-analysis-workspace')).gridTemplateColumns,
    overflow: document.documentElement.scrollWidth - window.innerWidth
  }));
  assert.match(desktop.columns, /px\s+\d+(?:\.\d+)?px/);
  assert.ok(desktop.overflow <= 1);
  assert.equal(mobile.columns.split(' ').length, 1);
  assert.ok(mobile.overflow <= 1);
  assert.equal(mobile.visible, true);
  assert.match(compactDesktop.columns, /px\s+\d+(?:\.\d+)?px/);
  assert.ok(compactDesktop.overflow <= 1);
});

test('复盘分析默认压缩为三条，并把核查方向融入下一步建议', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', '二面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: new Date('2026-08-01'), stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    window.setRawDataForTest([
      ...Array.from({ length: 8 }, (_, index) => candidate({ candidateId: 'phone-' + index, stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' })),
      ...Array.from({ length: 8 }, (_, index) => candidate({ candidateId: 'first-' + index, stageCode: 2, status: 'terminated', rawTerminationReason: '淘汰（面试/评审不通过）' })),
      ...Array.from({ length: 5 }, (_, index) => candidate({ candidateId: 'second-' + index, stageCode: 3, status: 'terminated', rawTerminationReason: '时间不合适' })),
      candidate({ candidateId: 'overdue', stageCode: 2, status: 'in_progress', stageDates: { 2: new Date('2026-07-20') } }),
      candidate({ candidateId: 'offer', stageCode: 4, status: 'offer_accepted_pending_onboard', expectedOnboardDate: new Date('2026-08-20') })
    ]);
    refreshData();
    switchMainView('reviewAnalysis');
    const before = document.querySelectorAll('#reviewAnalysisFindings .review-analysis-finding:not(.is-collapsed)').length;
    const hasQuestionSection = document.querySelectorAll('#reviewAnalysisFindings .analysis-question-list').length;
    const actions = Array.from(document.querySelectorAll('#reviewAnalysisFindings .finding-next-step')).map(node => node.textContent);
    const toggle = document.getElementById('reviewAnalysisMoreFindings');
    toggle?.click();
    const expanded = document.querySelectorAll('#reviewAnalysisFindings .review-analysis-finding:not(.is-collapsed)').length;
    toggle?.click();
    return {
      before,
      after: expanded,
      afterCollapse: document.querySelectorAll('#reviewAnalysisFindings .review-analysis-finding:not(.is-collapsed)').length,
      toggleText: toggle?.textContent,
      ariaExpanded: toggle?.getAttribute('aria-expanded'),
      hasQuestionSection,
      actions
    };
  });
  assert.equal(output.before, 3);
  assert.ok(output.after > 3);
  assert.equal(output.afterCollapse, 3);
  assert.match(output.toggleText, /查看其余/);
  assert.equal(output.ariaExpanded, 'false');
  assert.equal(output.hasQuestionSection, 0);
  assert.ok(output.actions.length >= 3);
  assert.ok(output.actions.every(text => !/抽样/.test(text)));
});

test('阶段×原因筛选栏与复盘证据筛选共用 detailFilters', async () => {
  const output = await page.evaluate(() => {
    navigateToDetails('stage-reason', { stageCode: 1, terminationReason: '不看机会/无意向' });
    const stage = document.getElementById('stageReasonStageFilter');
    const reason = document.getElementById('stageReasonReasonFilter');
    const initialStage = stage?.value;
    const initialReason = reason?.value;
    const compactDrill = document.getElementById('detailsDrilldownFilters').classList.contains('compact-drilldown');
    document.getElementById('stageReasonFilterReset')?.click();
    return {
      hasToolbar: Boolean(document.getElementById('stageReasonFilterToolbar')),
      filterInputs: document.querySelectorAll('#stageReasonFilterToolbar select, #stageReasonFilterToolbar input').length,
      stage: initialStage,
      reason: initialReason,
      resetStage: document.getElementById('stageReasonStageFilter')?.value,
      resetReason: document.getElementById('stageReasonReasonFilter')?.value,
      compactDrill
    };
  });
  assert.equal(output.hasToolbar, true);
  assert.equal(output.stage, '1');
  assert.equal(output.reason, '不看机会/无意向');
  assert.equal(output.filterInputs, 2);
  assert.equal(output.resetStage, '');
  assert.equal(output.resetReason, '');
  assert.equal(output.compactDrill, true);
});

test('阶段×原因表头和整行钻取使用招聘记录口径，二级Tab无圆角', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: '2026-08-01', stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides });
    window.setRawDataForTest([
      candidate({ candidateId: 'reason-1', stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' }),
      candidate({ candidateId: 'reason-2', stageCode: 1, status: 'terminated', rawTerminationReason: '不看机会/无意向' })
    ]);
    refreshData();
    navigateToDetails('stage-reason');
    const row = document.querySelector('#detailsStageReasonPanel tbody tr');
    row?.click();
    return {
      headers: Array.from(document.querySelectorAll('#detailsStageReasonPanel thead th')).map(node => node.textContent.trim()),
      detailActive: !document.getElementById('detailsPage').hidden,
      candidateTab: document.querySelector('[data-detail-tab="candidates"]')?.classList.contains('active'),
      stageFilter: detailFilters.stageCode,
      reasonFilter: detailFilters.terminationReason,
      tabStyle: (() => { const tab = document.querySelector('[data-detail-tab="stage-reason"]'); const style = getComputedStyle(tab); return { radius: style.borderRadius, background: style.backgroundColor, borderBottom: style.borderBottomColor }; })()
    };
  });
  assert.deepEqual(output.headers, ['阶段', '流失原因', '记录数', '占该阶段流失比例']);
  assert.equal(output.detailActive, true);
  assert.equal(output.candidateTab, true);
  assert.equal(output.stageFilter, 1);
  assert.equal(output.reasonFilter, '不看机会/无意向');
  assert.equal(output.tabStyle.radius, '0px');
  assert.equal(output.tabStyle.background, 'rgba(0, 0, 0, 0)');
});

test('自定义流程动态解析语义阶段且原始终止原因不被备注推断覆盖', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历', '一面', 'Offer', '入职']);
    const parsed = {
      firstInterview: parseMainStatus('一面'),
      pendingInterview: normalizeStatusText('待初面'),
      offer: parseMainStatus('Offer通过'),
      onboard: normalizeStatusText('已入职')
    };
    const rows = window.transformDataForTest([{
      'A.主阶段': '1-一面',
      'B.阶段状态': '终止',
      'C.终止原因': '',
      '备注': '薪资不合适',
      '候选人姓名': '原因真实性样本'
    }]);
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    return {
      parsed,
      sourceTerminationReason: rows[0].sourceTerminationReason,
      rawTerminationReason: rows[0].rawTerminationReason,
      inferredTerminationReason: rows[0].inferredTerminationReason,
      qualityIssues: rows[0].qualityIssues,
      reasons: result.reasonMatrix.map(row => row.terminationReason)
    };
  });
  assert.equal(output.parsed.firstInterview.code, 1);
  assert.equal(output.parsed.pendingInterview.stageCode, 1);
  assert.equal(output.parsed.offer.code, 2);
  assert.equal(output.parsed.onboard.stageCode, 3);
  assert.equal(output.sourceTerminationReason, '');
  assert.equal(output.rawTerminationReason, '');
  assert.equal(output.inferredTerminationReason, '薪资不符');
  assert.ok(output.qualityIssues.includes('缺失流失原因'));
  assert.deepEqual(output.reasons, ['原因未记录']);
});

test('自定义流程B按数字、配置名称和唯一语义解析真实阶段code', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '专业面', '终面', 'Offer', '入职']);
    return {
      numeric: parseMainStatus('2-专业面进行中'),
      label: normalizeStatusText('待专业面'),
      offer: parseMainStatus('Offer通过'),
      onboard: normalizeStatusText('已入职'),
      legacyNine: parseMainStatus('9-终止')
    };
  });
  assert.equal(output.numeric.code, 2);
  assert.equal(output.label.stageCode, 2);
  assert.equal(output.offer.code, 4);
  assert.equal(output.onboard.stageCode, 5);
  assert.equal(output.legacyNine.code, null);
  assert.equal(output.legacyNine.name, '终止');
});

test('月周总览展示完整单指标趋势和原始终止原因Top5，整体模式隐藏', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', stageDates: {}, stagePassDates: {}, rawTerminationReason: '', sourceTerminationReason: '', rawRemark: '', ...overrides });
    const rows = [
      candidate({ candidateId: 'jan', resumeTime: new Date('2026-01-05'), stageCode: 0, status: 'in_progress', processState: 'in_progress' }),
      candidate({ candidateId: 'feb-loss', resumeTime: new Date('2026-02-05'), stageCode: 1, status: 'terminated', processState: 'terminated_recruitment', sourceTerminationReason: '不看机会/无意向', rawTerminationReason: '不看机会/无意向' }),
      candidate({ candidateId: 'feb-missing', resumeTime: new Date('2026-02-06'), stageCode: 1, status: 'terminated', processState: 'terminated_unknown_reason', sourceTerminationReason: '', rawTerminationReason: '', rawRemark: '薪资不合适' })
    ];
    const overall = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    switchMainView('review');
    window.renderReviewPageForTest(overall);
    const overallHidden = document.getElementById('reviewTrendSection')?.hidden;
    const month = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'month', selectedMonth: '2026-02', selectedWeek: '' });
    window.renderReviewPageForTest(month);
    return {
      overallHidden,
      monthHidden: document.getElementById('reviewTrendSection')?.hidden,
      labels: month.trend.buckets.map(bucket => bucket.key),
      highlighted: document.querySelectorAll('#reviewTrendSection .trend-current-period').length,
      reasonText: document.getElementById('terminationReasonDistribution')?.textContent || '',
      reasonRows: document.querySelectorAll('#terminationReasonDistribution .reason-distribution-row').length
    };
  });
  assert.equal(output.overallHidden, true);
  assert.equal(output.monthHidden, false);
  assert.deepEqual(output.labels, ['2026-01', '2026-02']);
  assert.equal(output.highlighted, 1);
  assert.match(output.reasonText, /不看机会\/无意向/);
  assert.match(output.reasonText, /原因未记录/);
  assert.doesNotMatch(output.reasonText, /薪资不符/);
  assert.equal(output.reasonRows, 2);
});

test('趋势图由250px容器统一尺寸且比较说明位于绘图区外', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const candidate = overrides => ({ candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', stageDates: {}, stagePassDates: {}, rawTerminationReason: '', sourceTerminationReason: '', rawRemark: '', ...overrides });
    const rows = [
      candidate({ candidateId: 'mar', resumeTime: new Date('2026-03-05'), stageCode: 1, status: 'in_progress', processState: 'in_progress' }),
      candidate({ candidateId: 'apr', resumeTime: new Date('2026-04-05'), stageCode: 2, status: 'in_progress', processState: 'in_progress' }),
      candidate({ candidateId: 'may', resumeTime: new Date('2026-05-05'), stageCode: 3, status: 'in_progress', processState: 'in_progress' })
    ];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'month', selectedMonth: '2026-04', selectedWeek: '' });
    switchMainView('review');
    window.renderReviewPageForTest(result);
    const wrap = document.querySelector('#reviewTrendPanel .trend-chart-wrap');
    const svg = wrap?.querySelector('.offline-chart');
    const highlight = svg?.querySelector('.trend-current-period');
    return {
      wrapHeight: wrap ? getComputedStyle(wrap).height : '',
      svgHeight: svg ? getComputedStyle(svg).height : '',
      svgInlineHeight: svg?.getAttribute('height') || '',
      labelsRotated: Boolean(svg?.querySelector('text[transform*="rotate"]')),
      highlightOpacity: Number(highlight?.getAttribute('opacity') || 1),
      footerOutsideChart: Boolean(document.querySelector('#reviewTrendPanel > .trend-chart-footer')),
      footerText: document.querySelector('#reviewTrendPanel > .trend-chart-footer')?.textContent || '',
      reasonValues: Array.from(document.querySelectorAll('.reason-distribution-value')).map(node => node.textContent.trim())
    };
  });
  assert.equal(output.wrapHeight, '250px');
  assert.equal(output.svgHeight, '250px');
  assert.equal(output.svgInlineHeight, '100%');
  assert.equal(output.labelsRotated, false);
  assert.ok(output.highlightOpacity <= 0.08);
  assert.equal(output.footerOutsideChart, true);
  assert.match(output.footerText, /上一期|期间变化|已有期间/);
  assert.ok(output.reasonValues.every(value => /\d+\.\d%$/.test(value)));
});

test('视觉收尾使用紧凑筛选栏、自然文案且不以overflow hidden掩盖页面溢出', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const output = await page.evaluate(() => {
    document.getElementById('timeDimension').value = 'overall';
    document.getElementById('timeDimension').dispatchEvent(new Event('change', { bubbles: true }));
    switchMainView('reviewAnalysis');
    const analysisText = document.getElementById('reviewAnalysisContent').textContent;
    switchMainView('details');
    const detailsSubtitle = document.querySelector('#detailsPage .page-heading p')?.textContent.trim();
    switchMainView('attention');
    const attentionSubtitle = document.querySelector('.attention-board-header p')?.textContent.trim();
    const toolbar = document.querySelector('.filter-toolbar');
    const group = toolbar?.querySelector('.filter-group:not([hidden])');
    return {
      toolbarHeight: toolbar ? toolbar.getBoundingClientRect().height : 0,
      groupDirection: group ? getComputedStyle(group).flexDirection : '',
      monthHidden: document.getElementById('monthSelector').hidden,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      analysisText,
      detailsSubtitle,
      attentionSubtitle,
      mainFocusRuleUsesVisible: Array.from(document.styleSheets).flatMap(sheet => { try { return Array.from(sheet.cssRules || []); } catch { return []; } }).some(rule => rule.selectorText?.includes('.main-view-tab:focus-visible'))
    };
  });
  assert.ok(output.toolbarHeight >= 52 && output.toolbarHeight <= 56);
  assert.equal(output.groupDirection, 'row');
  assert.equal(output.monthHidden, true);
  assert.notEqual(output.bodyOverflowX, 'hidden');
  assert.doesNotMatch(output.analysisText, /核心证据|观察：|基于当前范围的真实数据|当前统一分析范围/);
  assert.match(output.analysisText, /数据依据/);
  assert.match(output.analysisText, /后续关注/);
  assert.equal(output.detailsSubtitle, '按阶段、岗位、渠道等维度查看招聘表现与明细记录。');
  assert.equal(output.attentionSubtitle, '集中查看当前需要推进、安排或确认结果的候选人。');
  assert.equal(output.mainFocusRuleUsesVisible, true);
});

test('分析明细默认阶段分析并为七个Tab保留独立局部筛选', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const rows = [
      { candidateId: 'a', candidateName: '候选人A', jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 1, processState: 'in_progress', stayDays: 5, slaState: 'overdue', qualityIssues: ['阶段日期缺失'], rawTerminationReason: '' },
      { candidateId: 'b', candidateName: '候选人B', jobName: '岗位B', source: '渠道B', company: '公司B', stageCode: 2, processState: 'terminated_recruitment', sourceTerminationReason: '淘汰', rawTerminationReason: '淘汰', qualityIssues: [] }
    ];
    window.setRawDataForTest(rows);
    refreshData();
    navigateToDetails('stage', { stageCode: 1 });
    const initial = {
      active: document.querySelector('.detail-view-tab.active')?.dataset.detailTab,
      tabs: Array.from(document.querySelectorAll('.detail-view-tab')).map(tab => tab.textContent.trim()),
      stageValue: document.getElementById('stageAnalysisStageFilter')?.value,
      headers: Array.from(document.querySelectorAll('#detailsStageMainTable thead th')).map(node => node.textContent.trim())
    };
    document.getElementById('stageAnalysisOnlyInventory').click();
    switchDetailView('jobs');
    document.getElementById('jobsKeywordFilter').value = '产品';
    document.getElementById('jobsKeywordFilter').dispatchEvent(new Event('input', { bubbles: true }));
    switchDetailView('stage');
    const preserved = {
      stageInventory: document.getElementById('stageAnalysisOnlyInventory').checked,
      globalMode: document.getElementById('timeDimension').value,
      jobsKeyword: detailViewFilters.jobs.keyword
    };
    return { initial, preserved };
  });
  assert.equal(output.initial.active, 'stage');
  assert.deepEqual(output.initial.tabs, ['阶段分析', '候选人明细', '流失原因', '岗位', '渠道', '人选来源公司', '数据质量']);
  assert.equal(output.initial.stageValue, '1');
  assert.deepEqual(output.initial.headers, ['阶段', '到达', '进入下一阶段', '真正流失', '当前库存', '阶段推进率', '当前平均停留i', '超SLA']);
  assert.equal(output.preserved.stageInventory, true);
  assert.equal(output.preserved.globalMode, 'overall');
  assert.equal(output.preserved.jobsKeyword, '产品');
});

test('其余分析子页具有独立筛选、重置且不改变全局范围', async () => {
  const output = await page.evaluate(() => {
    const ids = ['channelsFilterToolbar', 'companiesFilterToolbar', 'candidateDetailFilterToolbar', 'qualityFilterToolbar'];
    switchDetailView('channels');
    document.getElementById('channelsMinSampleFilter').value = '5';
    document.getElementById('channelsMinSampleFilter').dispatchEvent(new Event('change', { bubbles: true }));
    switchDetailView('companies');
    document.getElementById('companiesKeywordFilter').value = '甲';
    document.getElementById('companiesKeywordFilter').dispatchEvent(new Event('input', { bubbles: true }));
    switchDetailView('candidates');
    document.getElementById('candidateDetailStatusFilter').value = 'in_progress';
    document.getElementById('candidateDetailStatusFilter').dispatchEvent(new Event('change', { bubbles: true }));
    switchDetailView('quality');
    document.getElementById('qualitySearchFilter').value = '缺失阶段';
    document.getElementById('qualitySearchFilter').dispatchEvent(new Event('input', { bubbles: true }));
    return {
      toolbars: ids.map(id => Boolean(document.getElementById(id))),
      values: {
        channels: detailViewFilters.channels.minSample,
        companies: detailViewFilters.companies.keyword,
        candidates: detailViewFilters.candidates.processState,
        quality: detailViewFilters.quality.search
      },
      globalMode: document.getElementById('timeDimension').value
    };
  });
  assert.deepEqual(output.toolbars, [true, true, true, true]);
  assert.deepEqual(output.values, { channels: 5, companies: '甲', candidates: 'in_progress', quality: '缺失阶段' });
  assert.equal(output.globalMode, 'overall');
});

test('渠道和来源公司排序使用对应业务指标且候选人终止筛选合并展示', async () => {
  const output = await page.evaluate(() => {
    switchDetailView('channels');
    const channelSort = Array.from(document.querySelectorAll('#channelsFilterToolbar select')).at(-1);
    const channelSortValues = Array.from(channelSort.options).map(option => option.value);
    switchDetailView('companies');
    const companySort = Array.from(document.querySelectorAll('#companiesFilterToolbar select')).at(-1);
    const companyHeaders = Array.from(document.querySelectorAll('#detailsCompaniesPanel th')).map(node => node.textContent.trim());
    switchDetailView('candidates');
    const statusOptions = Array.from(document.getElementById('candidateDetailStatusFilter').options).map(option => ({ value: option.value, label: option.textContent.trim() }));
    document.getElementById('candidateDetailStatusFilter').value = 'terminated';
    document.getElementById('candidateDetailStatusFilter').dispatchEvent(new Event('change', { bubbles: true }));
    return {
      channelSortValues,
      companySortValues: Array.from(companySort.options).map(option => option.value),
      companyHeaders,
      statusOptions,
      filteredStatus: detailViewFilters.candidates.processState
    };
  });
  assert.ok(output.channelSortValues.includes('screenPass'));
  assert.ok(output.channelSortValues.includes('interviewOffer'));
  assert.ok(output.companySortValues.includes('firstInterviewRate'));
  assert.ok(Array.isArray(output.companyHeaders));
  assert.ok(output.statusOptions.some(option => option.value === 'terminated' && option.label === '已终止'));
  assert.equal(output.filteredStatus, 'terminated');
});

test('Attention 使用统一候选人结果并支持搜索、状态、风险和排序', async () => {
  const output = await page.evaluate(() => {
    const result = currentAnalysisResult;
    result.attentionCandidates = [
      { candidateId: 'x', candidateName: '候选人A', jobName: '岗位A', source: '渠道A', stageCode: 1, processState: 'in_progress', slaState: 'overdue', stayDays: 8, priority: 1, tags: ['进行中超 SLA'] },
      { candidateId: 'y', candidateName: '候选人B', jobName: '岗位B', source: '渠道B', stageCode: 2, processState: 'passed_pending_next', slaState: 'normal', stayDays: 2, priority: 4, tags: ['当前阶段已通过、待安排下一阶段'] }
    ];
    navigateToAttention();
    document.getElementById('attentionSearchFilter').value = '候选人A';
    document.getElementById('attentionSearchFilter').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('attentionRiskFilter').value = 'overdue';
    document.getElementById('attentionRiskFilter').dispatchEvent(new Event('change', { bubbles: true }));
    return {
      text: document.getElementById('attentionCandidateTable').textContent,
      filters: { ...attentionFilters },
      sourceCount: result.attentionCandidates.length,
      toolbar: Boolean(document.getElementById('attentionFilterToolbar'))
    };
  });
  assert.equal(output.toolbar, true);
  assert.equal(output.sourceCount, 2);
  assert.match(output.text, /候选人A/);
  assert.doesNotMatch(output.text, /候选人B/);
  assert.equal(output.filters.search, '候选人A');
  assert.equal(output.filters.risk, 'overdue');
});

test('视觉精修使用三段式复盘摘要、统一明细表基线和全宽空状态 Hero', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '电话联系', '一面', 'Offer', '入职']);
    const rows = [
      makeVisualRow({ candidateId: 'visual-a', candidateName: '候选人A', stageCode: 1, status: 'in_progress', processState: 'in_progress' }),
      makeVisualRow({ candidateId: 'visual-b', candidateName: '候选人B', stageCode: 2, status: 'terminated', processState: 'terminated_recruitment', rawTerminationReason: '淘汰（面试/评审不通过）', sourceTerminationReason: '淘汰（面试/评审不通过）' })
    ];
    function makeVisualRow(overrides) {
      return { candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: new Date('2026-08-01'), stageDates: {}, stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides };
    }
    window.setRawDataForTest(rows);
    refreshData();
    const result = currentAnalysisResult;
    result.reviewAnalysis = {
      executiveSummary: ['旧的连续说明一。', '旧的连续说明二。', '旧的连续说明三。'],
      findings: [{ conclusion: '电话联系阶段的候选人意愿和触达问题较为集中。', evidence: [], actions: ['查看相关记录。'], observationMetrics: [] }],
      priorityActions: [{ title: '跟进当前记录', description: '确认下一步安排。', observationMetric: '超SLA招聘记录数' }],
      currentRisks: { items: [] }, dataLimitations: [], periodChanges: null
    };
    switchMainView('reviewAnalysis');
    window.renderReviewAnalysisPageForTest(result);
    const summary = document.getElementById('reviewAnalysisExecutiveSummary');
    const summarySnapshot = {
      groups: Array.from(summary.querySelectorAll('.review-summary-group')).map(group => group.textContent.trim()),
      labels: Array.from(summary.querySelectorAll('.review-summary-label')).map(label => label.textContent.trim()),
      paragraphCount: summary.querySelectorAll(':scope > p').length
    };

    navigateToDetails('stage');
    const panel = document.querySelector('#detailsPage .worktable-panel');
    const toolbar = document.querySelector('#detailsStagePanel .detail-filter-toolbar');
    const mainWrap = document.querySelector('#detailsStageMainTable .analysis-table-wrap');
    const timingWrap = document.querySelector('#detailsStageTimingTable .analysis-table-wrap');
    const numericHeader = document.querySelector('#detailsStageMainTable th.is-numeric');
    const numericCell = document.querySelector('#detailsStageMainTable td.is-numeric');
    const rect = node => node ? ({ left: node.getBoundingClientRect().left, width: node.getBoundingClientRect().width }) : null;
    const detailsSnapshot = {
      panel: rect(panel), toolbar: rect(toolbar), mainWrap: rect(mainWrap), timingWrap: rect(timingWrap),
      timingEmpty: Boolean(document.querySelector('#detailsStageTimingTable .stage-timing-empty')),
      tableWidth: document.querySelector('#detailsStageMainTable table')?.getBoundingClientRect().width || 0,
      numericHeaderAlign: numericHeader ? getComputedStyle(numericHeader).textAlign : '',
      numericCellAlign: numericCell ? getComputedStyle(numericCell).textAlign : ''
    };

    window.setRawDataForTest([]);
    refreshData();
    switchMainView('review');
    const empty = document.getElementById('reviewNoDataState');
    const review = document.getElementById('reviewPage');
    const emptyRect = empty.getBoundingClientRect();
    const reviewRect = review.getBoundingClientRect();
    return {
      summarySnapshot,
      detailsSnapshot,
      empty: {
        widthDelta: Math.abs(emptyRect.width - reviewRect.width),
        minHeight: parseFloat(getComputedStyle(empty).minHeight),
        alignItems: getComputedStyle(empty).alignItems,
        justifyContent: getComputedStyle(empty).justifyContent
      }
    };
  });
  assert.deepEqual(output.summarySnapshot.labels, ['结果摘要', '主要发现', '当前动作']);
  assert.equal(output.summarySnapshot.groups.length, 3);
  assert.equal(output.summarySnapshot.paragraphCount, 0);
  assert.ok(output.detailsSnapshot.panel.width > 1200);
  assert.ok(Math.abs(output.detailsSnapshot.toolbar.left - output.detailsSnapshot.mainWrap.left) < 1);
  if (output.detailsSnapshot.timingWrap) {
    assert.ok(Math.abs(output.detailsSnapshot.mainWrap.left - output.detailsSnapshot.timingWrap.left) < 1);
    assert.ok(Math.abs(output.detailsSnapshot.mainWrap.width - output.detailsSnapshot.timingWrap.width) < 1);
  } else {
    assert.equal(output.detailsSnapshot.timingEmpty, true);
  }
  assert.ok(output.detailsSnapshot.tableWidth >= output.detailsSnapshot.mainWrap.width - 1);
  assert.equal(output.detailsSnapshot.numericHeaderAlign, 'right');
  assert.equal(output.detailsSnapshot.numericCellAlign, 'right');
  assert.ok(output.empty.widthDelta < 1);
  assert.ok(output.empty.minHeight >= 420);
  assert.equal(output.empty.alignItems, 'center');
  assert.equal(output.empty.justifyContent, 'center');
});

test('分析明细使用最终业务语义与固定 Tab 顺序', async () => {
  const output = await page.evaluate(() => ({
    tabs: Array.from(document.querySelectorAll('[data-detail-tab]')).map(tab => ({
      key: tab.dataset.detailTab,
      label: tab.textContent.trim()
    })),
    sourceTemplateStillUsesTerminationReason: buildRecruitmentTemplateDraft(getCurrentStages()).dataHeaders.includes('终止原因')
  }));
  assert.deepEqual(output.tabs, [
    { key: 'stage', label: '阶段分析' },
    { key: 'candidates', label: '候选人明细' },
    { key: 'stage-reason', label: '流失原因' },
    { key: 'jobs', label: '岗位' },
    { key: 'channels', label: '渠道' },
    { key: 'companies', label: '人选来源公司' },
    { key: 'quality', label: '数据质量' }
  ]);
  assert.equal(output.sourceTemplateStillUsesTerminationReason, true);
});

test('单岗位范围隐藏岗位 Tab 与候选人岗位列，并在岗位页失效时回退阶段分析', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    window.setRawDataForTest([
      { candidateId: 'single-a', candidateName: '候选人A', jobName: '岗位A', source: '渠道A', company: '公司A', stageCode: 1, status: 'in_progress', processState: 'in_progress', resumeTime: new Date('2026-08-01'), stageDates: { 0: new Date('2026-08-01'), 1: new Date('2026-08-03') }, stagePassDates: {} },
      { candidateId: 'single-b', candidateName: '候选人B', jobName: '岗位B', source: '渠道B', company: '公司B', stageCode: 1, status: 'in_progress', processState: 'in_progress', resumeTime: new Date('2026-08-02'), stageDates: { 0: new Date('2026-08-02'), 1: new Date('2026-08-04') }, stagePassDates: {} }
    ]);
    initTimeSelectors();
    replaceDetailViewFilters('candidates', {});
    refreshData();
    navigateToDetails('jobs');
    const jobSelect = document.getElementById('jobSelect');
    jobSelect.value = '岗位A';
    handleJobChange();
    const jobsTab = document.querySelector('[data-detail-tab="jobs"]');
    const afterSingle = {
      hidden: jobsTab.hidden,
      view: currentDetailView,
      stageVisible: !document.querySelector('[data-detail-panel="stage"]').hidden
    };
    switchDetailView('candidates');
    const singleHeaders = Array.from(document.querySelectorAll('#candidateDetailTable th')).map(node => node.textContent.trim());
    jobSelect.value = '';
    handleJobChange();
    const restoredHeaders = Array.from(document.querySelectorAll('#candidateDetailTable th')).map(node => node.textContent.trim());
    return {
      afterSingle,
      singleHeaders,
      restoredHeaders,
      restoredTabHidden: jobsTab.hidden,
      restoredView: currentDetailView,
      restoredJobValue: jobSelect.value,
      restoredScope: currentAnalysisResult.scope.selectedJobs
    };
  });
  assert.deepEqual(output.afterSingle, { hidden: true, view: 'stage', stageVisible: true });
  assert.equal(output.singleHeaders.includes('岗位'), false);
  assert.equal(output.restoredTabHidden, false);
  assert.equal(output.restoredHeaders.includes('岗位'), true, JSON.stringify(output));
  assert.equal(output.restoredView, 'candidates');
});

test('阶段分析隐藏无效时效噪音，最终阶段推进字段显示不可计算', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', '入职']);
    const stage = (code, label, overrides = {}) => ({
      code, label, reachedCount: 10, advancedCount: 5, realLossCount: 2,
      inFlightCount: 1, inProgressCount: 1, passedPendingCount: 0, offerPendingCount: 0,
      closedConversionRate: 71.4, slaOverdueCount: 0,
      currentStayStats: { validSampleCount: 0, averageDays: 0 },
      transitionTimeStats: { validSampleCount: 0, eligibleCount: 3, averageDays: 0, medianDays: 0, coverageRate: 0 },
      ...overrides
    });
    const base = {
      stageRows: [
        stage(0, '简历评审', { transitionTimeStats: { validSampleCount: 2, eligibleCount: 3, averageDays: 1.5, medianDays: 1, coverageRate: 66.7 } }),
        stage(1, '一面'),
        stage(2, '入职', { advancedCount: 0, closedConversionRate: 100 })
      ],
      reasonMatrix: [], jobs: [], channels: [], companies: [], candidateDetails: [],
      quality: { issues: [] }
    };
    window.renderAnalysisDetailsForTest(base);
    switchDetailView('stage');
    const mainRows = Array.from(document.querySelectorAll('#detailsStageMainTable tbody tr')).map(row => Array.from(row.cells).map(cell => cell.textContent.trim()));
    const timingRows = Array.from(document.querySelectorAll('#detailsStageTimingTable tbody tr')).map(row => row.textContent.trim());
    const partialNote = document.querySelector('.stage-timing-sample-note')?.textContent.trim() || '';
    const allInvalid = { ...base, stageRows: base.stageRows.map(item => ({ ...item, transitionTimeStats: { validSampleCount: 0, eligibleCount: 3, averageDays: 0, medianDays: 0, coverageRate: 0 } })) };
    window.renderAnalysisDetailsForTest(allInvalid);
    return {
      mainRows,
      timingRows,
      partialNote,
      emptyTitle: document.querySelector('#detailsStageTimingTable .stage-timing-empty h4')?.textContent.trim() || '',
      emptyText: document.querySelector('#detailsStageTimingTable .stage-timing-empty p')?.textContent.trim() || '',
      qualityLink: document.querySelector('#detailsStageTimingTable .stage-timing-empty button')?.textContent.trim() || ''
    };
  });
  assert.equal(output.mainRows.some(row => row.includes('暂无有效样本')), false);
  assert.equal(output.mainRows.at(-1)[2], '—');
  assert.equal(output.mainRows.at(-1)[5], '—');
  assert.equal(output.timingRows.length, 1);
  assert.match(output.partialNote, /其余流转环节暂无有效日期样本/);
  assert.equal(output.emptyTitle, '阶段流转时效');
  assert.match(output.emptyText, /当前阶段日期覆盖不足/);
  assert.equal(output.qualityLink, '查看数据质量 ›');
});

test('数据质量区分需要关注的问题与正常状态且不引入阈值判断', async () => {
  const output = await page.evaluate(() => {
    const result = {
      stageRows: [], reasonMatrix: [], jobs: [], channels: [], companies: [], candidateDetails: [],
      quality: {
        terminationReasonCompletenessRate: 100,
        stageDateCoverageRate: 82.5,
        standardFunnelCoverageRate: 100,
        missingSpecificReasonCount: 0,
        missingStageDateCount: 7,
        excludedMissingDateCount: 3,
        issues: []
      }
    };
    window.renderAnalysisDetailsForTest(result);
    switchDetailView('quality');
    return {
      attention: Array.from(document.querySelectorAll('#detailsQualityPanel .quality-attention-item')).map(node => node.textContent.trim()),
      normal: Array.from(document.querySelectorAll('#detailsQualityPanel .quality-normal-status')).map(node => node.textContent.trim()),
      oldCards: document.querySelectorAll('#detailsQualityPanel .attention-stat-card').length
    };
  });
  assert.ok(output.attention.some(text => /阶段日期覆盖率 82.5%/.test(text) && /部分阶段时效暂无法计算/.test(text)));
  assert.ok(output.attention.some(text => /时间筛选排除了 3 条缺少日期的招聘记录/.test(text)));
  assert.ok(output.normal.some(text => /流失原因完整率 100%/.test(text)));
  assert.ok(output.normal.some(text => /标准漏斗覆盖率 100%/.test(text)));
  assert.equal(output.oldCards, 0);
});

test('所有文本搜索支持连续输入并在刷新后恢复焦点与光标', async () => {
  const output = await page.evaluate(async () => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    window.setRawDataForTest([
      makeRow({ candidateId: 'search-a', candidateName: 'abc候选人', jobName: 'abc岗位', source: 'abc渠道', company: 'abc公司', stageCode: 1, processState: 'in_progress', status: 'in_progress', stageDates: { 1: new Date('2026-07-01') }, qualityIssues: [{ label: 'abc问题' }] })
    ]);
    function makeRow(overrides) { return { resumeTime: new Date('2026-07-01'), stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides }; }
    initTimeSelectors();
    refreshData();
    const typeAndCheck = async (view, selector, attention = false) => {
      if (attention) navigateToAttention(); else navigateToDetails(view);
      let input = document.querySelector(selector);
      input.focus();
      for (const char of 'abc') {
        input = document.querySelector(selector);
        input.value += char;
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 35));
      }
      await new Promise(resolve => setTimeout(resolve, 260));
      input = document.querySelector(selector);
      return { value: input?.value, focused: document.activeElement === input, cursor: input?.selectionStart };
    };
    return {
      candidates: await typeAndCheck('candidates', '#candidateDetailSearch'),
      jobs: await typeAndCheck('jobs', '#jobsKeywordFilter'),
      channels: await typeAndCheck('channels', '#channelsSearchFilter'),
      companies: await typeAndCheck('companies', '#companiesKeywordFilter'),
      quality: await typeAndCheck('quality', '#qualitySearchFilter'),
      attention: await typeAndCheck('', '#attentionSearchFilter', true)
    };
  });
  Object.values(output).forEach(state => assert.deepEqual(state, { value: 'abc', focused: true, cursor: 3 }));
});

test('候选人明细显示总量与简单分页而不是静默截断50条', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', '入职']);
    window.setRawDataForTest(Array.from({ length: 120 }, (_, index) => ({
      candidateId: 'page-' + index,
      candidateName: '候选人' + String(index + 1).padStart(3, '0'),
      jobName: '岗位A', source: '渠道A', company: '公司A',
      stageCode: 1, processState: 'in_progress', status: 'in_progress',
      resumeTime: new Date('2026-07-01'), stageDates: { 1: new Date('2026-07-02') }, stagePassDates: {}, rawTerminationReason: '', rawRemark: ''
    })));
    initTimeSelectors();
    replaceDetailViewFilters('candidates', {});
    refreshData();
    navigateToDetails('candidates');
    const first = {
      summary: document.querySelector('.candidate-pagination-summary')?.textContent.trim() || '',
      rows: document.querySelectorAll('#candidateDetailTable tbody tr').length,
      page: document.querySelector('.candidate-pagination-page')?.textContent.trim() || ''
    };
    changeCandidateDetailPage(1);
    const second = {
      summary: document.querySelector('.candidate-pagination-summary')?.textContent.trim() || '',
      rows: document.querySelectorAll('#candidateDetailTable tbody tr').length,
      firstName: document.querySelector('#candidateDetailTable tbody tr .table-link')?.textContent.trim() || '',
      page: document.querySelector('.candidate-pagination-page')?.textContent.trim() || ''
    };
    return { first, second };
  });
  assert.deepEqual(output.first, { summary: '共 120 条，当前展示 1–50 条', rows: 50, page: '1 / 3' });
  assert.deepEqual(output.second, { summary: '共 120 条，当前展示 51–100 条', rows: 50, firstName: '候选人051', page: '2 / 3' });
});

test('数据质量使用当前在手记录定义日期覆盖率并隐藏零问题和内部原因分类', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', '入职']);
    const rows = [
      makeRow({ candidateId: 'covered', stageCode: 1, processState: 'in_progress', status: 'in_progress', stageDates: { 1: new Date('2026-07-01') } }),
      makeRow({ candidateId: 'missing', stageCode: 1, processState: 'in_progress', status: 'in_progress', stageDates: {} }),
      makeRow({ candidateId: 'done', stageCode: 2, processState: 'completed', status: 'passed', stageDates: { 2: new Date('2026-07-02') } }),
      makeRow({ candidateId: 'other-reason', stageCode: 1, processState: 'terminated_recruitment', status: 'terminated', rawTerminationReason: '其他自定义原文', standardReason: '其他', stageDates: { 1: new Date('2026-07-02') } })
    ];
    function makeRow(overrides) { return { candidateName: '候选人', jobName: '岗位A', source: '渠道A', company: '公司A', resumeTime: new Date('2026-07-01'), stagePassDates: {}, rawTerminationReason: '', rawRemark: '', ...overrides }; }
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    window.renderAnalysisDetailsForTest(result);
    switchDetailView('quality');
    return {
      rate: result.quality.stageDateCoverageRate,
      attention: document.querySelector('#detailsQualityPanel .quality-attention-list')?.textContent || '',
      options: Array.from(document.querySelectorAll('#qualityIssueTypeFilter option')).map(option => option.textContent.trim()),
      table: document.getElementById('qualityIssueDetails').textContent
    };
  });
  assert.equal(output.rate, 50);
  assert.match(output.attention, /当前阶段日期覆盖率 50%/);
  assert.match(output.attention, /1 条在手记录缺少有效阶段日期/);
  assert.doesNotMatch(output.options.join(' '), /无法识别流失原因分类/);
  assert.doesNotMatch(output.table, /0 条|无法识别流失原因分类/);
});

test('复盘页面与报告统一三层结构、招聘记录口径及整体分析文件名', async () => {
  const output = await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    const rows = [{ candidateId: 'done', stageCode: 3, processState: 'completed', status: 'passed', jobName: '产品', resumeTime: new Date('2026-07-01'), stageDates: { 3: new Date('2026-07-02') }, stagePassDates: {} }];
    const result = window.buildAnalysisResultForTest(rows, { selectedJobs: [], timeMode: 'overall', selectedMonth: '', selectedWeek: '' });
    result.reviewAnalysis = {
      executiveSummary: ['结果摘要'],
      findings: [{ conclusion: '复盘发现', evidence: [{ label: '数据依据', value: '1条招聘记录', detail: '事实依据' }], furtherQuestions: ['核查方向'], actions: ['执行动作'], observationMetrics: ['结果指标'], limitations: [] }],
      priorityActions: [], currentRisks: { items: [] }, dataLimitations: [], periodChanges: null
    };
    window.renderReviewAnalysisPageForTest(result);
    const report = window.generateReviewReportForTest(result);
    return {
      pageText: document.getElementById('reviewAnalysisFindings').textContent,
      report,
      filename: getReviewReportFilename(result),
      offerDefinition: result.businessKpis.offerCount.definition,
      onboardDefinition: result.businessKpis.onboardCount.definition
    };
  });
  for (const label of ['数据依据', '下一步建议', '后续关注']) {
    assert.match(output.pageText, new RegExp(label));
    assert.match(output.report, new RegExp(label));
  }
  assert.doesNotMatch(output.report, /数据证据|建议进一步了解|建议动作：/);
  assert.equal(output.filename, '招聘数据复盘_全部岗位_整体分析_全部时间.txt');
  assert.match(output.offerDefinition, /招聘记录数/);
  assert.match(output.onboardDefinition, /招聘记录/);
});

test('表格人数比例与时长右对齐，业务文字列保持左对齐', async () => {
  const output = await page.evaluate(() => {
    renderCompactTable('detailsStageMainTable', ['阶段', '人数', '占比', '平均停留', '渠道'], [['一面', 12, '35%', '3天', '渠道A']], '');
    return {
      headers: Array.from(document.querySelectorAll('#detailsStageMainTable th')).map(node => node.classList.contains('is-numeric')),
      cells: Array.from(document.querySelectorAll('#detailsStageMainTable td')).map(node => node.classList.contains('is-numeric'))
    };
  });
  assert.deepEqual(output.headers, [false, true, true, true, false]);
  assert.deepEqual(output.cells, [false, true, true, true, false]);
});

test('浏览器点击下载复盘报告并使用当前筛选文件名', async () => {
  await page.evaluate(() => {
    window.setCurrentStagesForTest(['简历评审', '一面', 'Offer', '入职']);
    window.setRawDataForTest([{ candidateId: 'download-done', candidateName: '候选人A', jobName: '岗位A', stageCode: 3, processState: 'completed', status: 'passed', resumeTime: new Date('2026-07-01'), stageDates: { 3: new Date('2026-07-02') }, stagePassDates: {}, rawTerminationReason: '', rawRemark: '' }]);
    initTimeSelectors();
    document.getElementById('timeDimension').value = 'overall';
    refreshData();
    switchMainView('reviewAnalysis');
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载复盘报告' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), '招聘数据复盘_全部岗位_整体分析_全部时间.txt');
});

try {
  await page.goto(pathToFileURL(path.resolve('index.html')).href);
  for (const item of cases) {
    await item.run();
    console.log('✓ ' + item.name);
  }
  assert.deepEqual(pageErrors, [], '页面不应出现 pageerror');
  assert.deepEqual(consoleErrors, [], '页面不应出现 console.error');
} finally {
  await browser.close();
}
