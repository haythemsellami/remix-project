import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, showOpcodes, currentOpcode, step } from './helpers'

test.use({ contractFile: 'MonadUnit_test.sol' })
const storeLine = readFileSync('libs/remix-monad/examples/MonadUnit_test.sol', 'utf8').split('\n').findIndex(line => line.includes('value = value + 1;')) + 1

for (const fork of ['monad-next', 'monad-ten'] as const) {
  test(`${fork}: run Solidity tests, inspect console output and debug test results`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').click()
    await page.locator('[data-id="uiPathInput"]').fill('')
    await expect(page.locator('[data-id="singleTest"]').filter({ hasText: 'MonadUnit_test.sol' })).toBeVisible()
    await page.locator('input.singleTest').check()
    await page.locator('[data-id="testTabRunTestsTabRunAction"]').click()
    const output = page.locator('[data-id="testTabSolidityUnitTestsOutput"]')
    await expect(output.locator('.testLog')).toHaveCount(7, { timeout: 60_000 })
    await expect(page.locator('[data-id="testTabRunTestsTabStopAction"]')).toBeDisabled()
    await expect(output.locator('.testPass')).toHaveCount(fork === 'monad-next' ? 4 : 3)
    await expect(output).toContainText('intentional assertion failure')
    await expect(output).toContainText('function returned false')
    const terminal = page.locator('[data-id="terminalJournal"]')
    if (!await terminal.isVisible()) await page.locator('[data-id="toggleBottomPanelIcon"]').click()
    for (const message of ['monad-store', 'monad-assertion', 'monad-revert', 'monad-view', 'monad-view-failure']) {
      await expect(terminal).toContainText(message)
    }
    for (const [name, status] of [['Test_store', 'Success'], ['Test_assertion_failure', 'Success'], ['Test_revert', 'Failed'], ['Test_read_only', 'Success']]) {
      if (!await output.isVisible()) await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').click()
      await output.locator(`[id="${name}"]`).click()
      await expect(page.locator('[data-id="txStatus"]')).toHaveText(status)
      await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
      await showOpcodes(page)
      await step(page, 'forward')
      await step(page, 'back')
      await expect(page.locator('#editorView [class*="highlightLine"]').first()).toBeVisible()
      if (name === 'Test_store') {
        for (let i = 0; i < 100 && !(await currentOpcode(page).innerText()).includes('SSTORE'); i++) await step(page, 'forward')
        await expect(currentOpcode(page)).toContainText('SSTORE')
        await expect(page.locator(`#editorView .highlightLine${storeLine}`).first()).toBeVisible()
        await step(page, 'forward')
        await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
        const state = page.locator('[data-id="solidityState"]')
        await state.locator('[data-id="state-expand-icon"]').click()
        await state.locator('[data-id="value-expand-icon"]').click()
        await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText('"42"')
      }
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    }
    if (!await output.isVisible()) await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').click()
    await output.locator('[id="Test_monad_opcode"]').click()
    await expect(page.locator('[data-id="txStatus"]')).toHaveText(fork === 'monad-next' ? 'Success' : 'Failed')
    await showOpcodes(page)
    const opcode = fork === 'monad-next' ? 'CALLSTACKDEPTH' : 'INVALID'
    for (let i = 0; i < 250 && !(await currentOpcode(page).innerText()).includes(opcode); i++) await step(page, 'forward')
    await expect(currentOpcode(page)).toContainText(opcode)
  })
}
