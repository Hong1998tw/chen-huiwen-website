import assert from 'node:assert/strict';
import {
  assertPetitionPreservesOriginalContent,
  PETITION_APPROVED_DISCLOSURE,
  PETITION_PRIOR_NOTICE,
} from './petition-preservation.mjs';

const baselineMain = `<main id="main"><section class="page-head"><div class="wrap"><p class="eyebrow">TELL US YOUR CONCERNS</p><h1>服務案件表單</h1><p>把生活中的問題告訴我們，讓服務處能與你聯繫、了解需求。</p></div></section><section class="wrap petition-panel"><div><p class="eyebrow">WE ARE HERE TO HELP</p><h2>你的問題，我們一起面對。</h2><p>道路、環境、公共設施或生活上的困難，歡迎使用線上表單登記，也可致電服務處反映。</p><div class="actions"><a class="button button-green" href="https://lihong-tw.notion.site/1ffbd1468054800b9940fbfde5fee74d" target="_blank" rel="noopener noreferrer">前往服務案件登記 ↗</a><a class="button button-outline" href="tel:+88678212536">電話聯絡 ↗</a></div>${PETITION_PRIOR_NOTICE}</div><ol class="prepare-list"><li><strong>聯絡資料</strong><p>姓名、電話與方便聯絡的時段。</p></li><li><strong>問題與地點</strong><p>說明發生什麼事、持續多久，以及希望如何改善。</p></li><li><strong>附件與反映紀錄</strong><p>可附現場照片或相關文件；若曾向機關反映，請提供案號。</p></li></ol></section><section class="section wrap"><h2>需要法律諮詢？</h2><p>法律諮詢請先確認服務資訊，再致電服務處預約。</p><div class="actions"><a class="button button-green" href="service.html#monthly-heading" target="_blank" rel="noopener noreferrer">法律諮詢資訊 ↗</a><a class="text-link" href="service.html#legal">諮詢須知與服務時間 →</a></div></section></main>`;

const approvedMain = baselineMain
  .replace('TELL US YOUR CONCERNS', '反映服務需求')
  .replace('WE ARE HERE TO HELP', '服務協助')
  .replace('電話聯絡 ↗', '電話聯絡 →')
  .replace('法律諮詢資訊 ↗', '法律諮詢資訊 →')
  .replace(PETITION_PRIOR_NOTICE, PETITION_APPROVED_DISCLOSURE);

assert.doesNotThrow(() => assertPetitionPreservesOriginalContent(baselineMain, approvedMain));

const rejected = (label, mutate) => {
  assert.throws(
    () => assertPetitionPreservesOriginalContent(baselineMain, mutate(approvedMain)),
    undefined,
    `${label} must remain a failure`,
  );
};

rejected('arbitrary body copy', current => current.replace('你的問題，我們一起面對。', '你的需求，我們一起面對。'));
rejected('arbitrary URL', current => current.replace('1ffbd1468054800b9940fbfde5fee74d', 'changed-form-url'));
rejected('telephone number', current => current.replace('tel:+88678212536', 'tel:+88670000000'));
rejected('added element', current => current.replace('</main>', '<p>未核定的新內容</p></main>'));
rejected('arbitrary eyebrow', current => current.replace('服務協助', '服務申請'));

console.log('Petition preservation pure checks: 1 approved case passed; 5 unapproved changes rejected.');
