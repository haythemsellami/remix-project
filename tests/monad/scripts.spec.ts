import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, showOpcodes, currentOpcode, step } from './helpers'

test.use({ scriptRunner: true })
// Compile, run two scripts, sign from the file explorer, then debug both transactions.
test.describe.configure({ timeout: 180_000 })
const storeLine = readFileSync('libs/remix-monad/examples/MonadDemo.sol', 'utf8').split('\n').findIndex(line => line.includes('value = newValue;')) + 1

async function fileExplorer(page: Page) {
  if (!await page.locator('[data-id="treeViewUltreeViewMenu"]').isVisible()) {
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
  }
}

async function runScript(page: Page, file: string) {
  await fileExplorer(page)
  await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles(`libs/remix-monad/examples/${file}`)
  await page.locator(`[data-id="treeViewLitreeViewItem${file}"]`).click()
  await page.locator('[data-id="run-script-dropdown-trigger"]').click()
  await page.locator('[data-id="run-with-ethers6-menu-item"]').click()
}

async function debugHash(page: Page, hash: string, status: string) {
  const input = page.locator('[data-id="debuggerTransactionInput"]')
  if (!await input.isVisible()) await page.locator('#icon-panel div[plugin="debugger"]').click()
  await input.fill(hash)
  await page.getByRole('button', { name: 'Start debugging', exact: true }).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText(status)
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
}

for (const fork of ['monad-next', 'monad-ten'] as const) {
  test(`${fork}: run JavaScript and TypeScript, sign typed data and debug script transactions`, async ({ page }) => {
    await selectEnvironment(page, fork)
    const terminal = page.locator('[data-id="terminalJournal"]')
    if (!await terminal.isVisible()) await page.locator('[data-id="toggleBottomPanelIcon"]').click()
    let storeHash: string
    let opcodeHash: string

    await test.step('Deploy, write storage and decode events from a JavaScript file', async () => {
      await runScript(page, 'deploy-script.js')
      const output = /script-js-ok\s+(0x[0-9a-fA-F]{40})\s+(0x[0-9a-fA-F]{64})/
      await expect(terminal).toContainText(output, { timeout: 60_000 })
      storeHash = (await terminal.innerText()).match(output)[2]
      await page.locator('#icon-panel div[plugin="udapp"]').click()
      await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('1')
    })

    await test.step('Sign from TypeScript and execute an opcode with the selected Monad fork', async () => {
      await runScript(page, 'sign-and-execute.ts')
      const output = /script-ts-ok\s+(0x[0-9a-fA-F]{64})\s+(\d)\s+(\d+)/
      await expect(terminal).toContainText(output, { timeout: 60_000 })
      const result = (await terminal.innerText()).match(output)
      opcodeHash = result[1]
      expect(result.slice(2)).toEqual(fork === 'monad-next' ? ['1', '1'] : ['0', '42'])
    })

    await test.step('Use the existing file-explorer signing action with the same typed data', async () => {
      const signature = (await terminal.innerText()).match(/script-signature-ok\s+(0x[0-9a-fA-F]{40})\s+(0x[0-9a-fA-F]{130})/)
      expect(signature).not.toBeNull()
      await fileExplorer(page)
      await page.locator('[data-id="treeViewLitreeViewItemMonadTypedData.json"]').click({ button: 'right' })
      await page.locator('[data-id="contextMenuItemsignTypedData"]').click()
      await expect(terminal).toContainText(`MonadTypedData.json signature using ${signature[1]} : ${signature[2]}`)
    })

    await test.step('Debug the earlier JavaScript storage write with source and decoded state', async () => {
      await debugHash(page, storeHash, 'Success')
      await showOpcodes(page)
      for (let i = 0; i < 80 && !/\bSSTORE\b/.test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
      await expect(currentOpcode(page)).toContainText('SSTORE')
      await expect(page.locator(`#editorView .highlightLine${storeLine}`).first()).toBeVisible()
      await step(page, 'forward')
      await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
      const state = page.locator('[data-id="solidityState"]')
      await state.locator('[data-id="state-expand-icon"]').click()
      await state.locator('[data-id="value-expand-icon"]').click()
      await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText('"42"')
      await showOpcodes(page)
      await step(page, 'back')
      await expect(currentOpcode(page)).toContainText('SSTORE')
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    })

    await test.step('Debug the TypeScript opcode transaction, including rejection on Monad Ten', async () => {
      await debugHash(page, opcodeHash, fork === 'monad-next' ? 'Success' : 'Failed')
      const collapsed = page.locator('.call-trace-expand-icon.fa-plus-square')
      for (let i = 0; i < 20 && await collapsed.count(); i++) await collapsed.first().click()
      const call = page.locator('.call-trace-item').filter({ has: page.locator('[data-id="call-trace-type-staticcall"]') })
      await expect(call).toHaveCount(1)
      await call.click()
      await showOpcodes(page)
      await expect(currentOpcode(page)).toContainText('STATICCALL')
      await step(page, 'forward')
      await expect(currentOpcode(page)).toHaveText(fork === 'monad-next' ? /^\s*0+\s+CALLSTACKDEPTH\s*$/ : /^\s*0+\s+INVALID\s*$/)
      await step(page, 'back')
      await expect(currentOpcode(page)).toContainText('STATICCALL')
    })
  })
}
