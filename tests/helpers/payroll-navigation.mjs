import assert from "node:assert/strict";

// Exercise the same visible menu controls as an administrator. Never reveal
// hidden panels from the test, since that would bypass navigation regressions.
export async function openPayrollView(page, view) {
  assert.ok(["ledger", "employees", "attendance", "payments", "services"].includes(view));
  const tab = page.locator(`[data-payroll-tab="${view}"]`);
  await tab.click();
  await page.locator(`#view-${view}`).waitFor({ state: "visible" });
  assert.equal(await tab.getAttribute("role"), "tab");
  assert.equal(await tab.getAttribute("aria-selected"), "true");
  for (const other of ["ledger", "employees", "attendance", "payments", "services"]) {
    assert.equal(await page.locator(`#view-${other}`).isVisible(), other === view,
      `only the selected ${view} payroll menu is visible`);
    assert.equal(await page.locator(`[data-payroll-tab="${other}"]`).getAttribute("aria-selected"), String(other === view));
    assert.equal(await page.locator(`#view-${other}`).getAttribute("role"), "tabpanel");
  }
  assert.equal(new URL(page.url()).hash, `#${view}`);
}
