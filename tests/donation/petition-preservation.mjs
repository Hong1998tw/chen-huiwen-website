import assert from 'node:assert/strict';

export const PETITION_PRIOR_NOTICE = '<p>線上表單為陳慧文議員服務案件登記入口。送出前請確認填寫資料正確；如需協助，也可先查看<a class="text-link" href="service.html#contact">服務處聯絡資訊</a>。</p>';
export const PETITION_APPROVED_DISCLOSURE = '<p>線上表單會在新分頁開啟外部 Notion 網站，填寫與送出都在該網站進行；本頁不會顯示填寫或送出狀態。若不使用線上表單，可直接致電服務處。送出前請確認填寫資料正確；需要聯絡資訊時可查看<a class="text-link" href="service.html#contact">服務處聯絡資訊</a>。</p>';

const pageHeadEyebrow = '<section class="page-head"><div class="wrap"><p class="eyebrow">';
const petitionEyebrow = '<section class="wrap petition-panel"><div><p class="eyebrow">';

const approvedVariants = [
  {
    name: 'page heading eyebrow',
    variants: [
      `${pageHeadEyebrow}TELL US YOUR CONCERNS</p>`,
      `${pageHeadEyebrow}反映服務需求</p>`,
    ],
    canonical: `${pageHeadEyebrow}反映服務需求</p>`,
  },
  {
    name: 'petition panel eyebrow',
    variants: [
      `${petitionEyebrow}WE ARE HERE TO HELP</p>`,
      `${petitionEyebrow}服務協助</p>`,
    ],
    canonical: `${petitionEyebrow}服務協助</p>`,
  },
  {
    name: 'telephone action arrow',
    variants: [
      '<a class="button button-outline" href="tel:+88678212536">電話聯絡 ↗</a>',
      '<a class="button button-outline" href="tel:+88678212536">電話聯絡 →</a>',
    ],
    canonical: '<a class="button button-outline" href="tel:+88678212536">電話聯絡 →</a>',
  },
  {
    name: 'legal information action arrow',
    variants: [
      '<a class="button button-green" href="service.html#monthly-heading" target="_blank" rel="noopener noreferrer">法律諮詢資訊 ↗</a>',
      '<a class="button button-green" href="service.html#monthly-heading" target="_blank" rel="noopener noreferrer">法律諮詢資訊 →</a>',
    ],
    canonical: '<a class="button button-green" href="service.html#monthly-heading" target="_blank" rel="noopener noreferrer">法律諮詢資訊 →</a>',
  },
];

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function canonicalizeOneApprovedVariant(source, {name, variants, canonical}) {
  const matches = variants.filter(fragment => occurrences(source, fragment) === 1);
  const total = variants.reduce((sum, fragment) => sum + occurrences(source, fragment), 0);
  assert.equal(total, 1, `${name} must match exactly one approved full fragment`);
  assert.equal(matches.length, 1, `${name} cannot contain both approved forms`);
  return source.replace(matches[0], canonical);
}

function canonicalizeApprovedChanges(main) {
  return approvedVariants.reduce(canonicalizeOneApprovedVariant, main);
}

export function assertPetitionPreservesOriginalContent(baselineMain, currentMain) {
  assert.equal(occurrences(baselineMain, PETITION_PRIOR_NOTICE), 1, 'the historical baseline notice must appear exactly once');
  assert.equal(occurrences(currentMain, PETITION_APPROVED_DISCLOSURE), 1, 'the approved disclosure must appear exactly once');

  const baseline = canonicalizeApprovedChanges(baselineMain);
  const restoredCurrent = currentMain.replace(PETITION_APPROVED_DISCLOSURE, PETITION_PRIOR_NOTICE);
  const current = canonicalizeApprovedChanges(restoredCurrent);
  assert.equal(current, baseline, 'Every prior main-content element outside the approved disclosure and exact G05 UI variants remains intact');
}
