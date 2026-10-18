export async function openCaseFilterDialog(page) {
 const trigger=page.locator('#case-filter-open');
 if(await trigger.isVisible()&&!await page.locator('#case-filter-dialog').evaluate(dialog=>dialog.open))await trigger.click();
}

export async function closeCaseFilterDialog(page) {
 const dialog=page.locator('#case-filter-dialog');
 if(await dialog.evaluate(element=>element.open))await page.locator('#case-filter-close').click();
}
