import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, deploy, openContract, debugTransaction, currentOpcode, showOpcodes, step } from './helpers'

test.use({ contractFile: 'DelegatedAccount.sol', scriptRunner: true })
test.describe.configure({ timeout: 300_000 })
const source = readFileSync('libs/remix-monad/examples/DelegatedAccount.sol', 'utf8')
const storeLine = source.split('\n').findIndex(line => line.includes('value = newValue')) + 1
const rpc = (page: Page, method: string, ...params: any[]) => page.evaluate(
  ({ method, params }) => (window as any).__remixVM_web3.send(method, params), { method, params }
)

async function decodedValue(page: Page, value: number) {
  await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
  const state = page.locator('[data-id="solidityState"]')
  for (const key of ['state', 'value']) {
    const toggle = state.locator(`[data-id="${key}-expand-icon"]`)
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute('class')).includes('fa-plus-square')) await toggle.click()
  }
  await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText(`"${value}"`)
}

async function inspectStore(page: Page, expected: number) {
  await showOpcodes(page)
  for (let i = 0; i < 180 && !/\bSSTORE\b/.test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
  await expect(currentOpcode(page)).toContainText('SSTORE')
  await expect(page.locator(`#editorView .highlightLine${storeLine}`).first()).toBeVisible()
  await step(page, 'forward')
  await decodedValue(page, expected)
  await showOpcodes(page)
  await step(page, 'back')
  await expect(currentOpcode(page)).toContainText('SSTORE')
  await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
}

async function debugHash(page: Page, hash: string, status = 'Success') {
  const input = page.locator('[data-id="debuggerTransactionInput"]')
  if (!await input.isVisible()) await page.locator('#icon-panel div[plugin="debugger"]').click()
  await input.fill(hash)
  await page.getByRole('button', { name: 'Start debugging', exact: true }).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText(status)
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: authorize, execute, revoke and debug through the delegation UI`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'DelegatedAccount')
    const state = await rpc(page, 'eth_getStateDb')
    const deployment = state.blocks.at(-1).transactions[0]
    const target = (await rpc(page, 'eth_getTransactionReceipt', deployment)).contractAddress
    const [authority] = await rpc(page, 'eth_accounts')
    await page.locator('[data-id="runTabSelectAccount"]').hover()
    await page.locator('[data-id="selected-account-kebab-menu"]').click()
    await page.locator('[data-id="authorizeDelegation"]').click()
    await page.locator('[data-id="create-delegation-authorization-input"]').fill(target)
    await page.locator('[data-id="createDelegationAuthorization-modal-footer-ok-react"]').click()
    await expect(page.locator('[data-id="delete-delegation"]')).toBeVisible()
    await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('2')
    expect(await rpc(page, 'eth_getCode', authority)).toBe('0xef0100' + target.slice(2).toLowerCase())

    await openContract(page)
    if (!await page.locator('[data-id="functionList-1"]').isVisible()) await page.locator('[data-id="deployedContractItem-1"]').click()
    const store = page.locator('[data-id^="deployedContractItem-1-function-"]').filter({ has: page.locator('[title="store"]') })
    await store.locator('input').fill('42')
    const buttons = page.locator('[data-shared="txLoggerDebugButton"]')
    const count = await buttons.count()
    await store.getByRole('button', { name: 'Transact', exact: true }).click()
    await expect(buttons).toHaveCount(count + 1)
    const button = await buttons.last().getAttribute('data-id')
    expect(BigInt(await rpc(page, 'eth_getStorageAt', authority, '0x0'))).toBe(42n)
    expect(BigInt(await rpc(page, 'eth_getStorageAt', target, '0x0'))).toBe(0n)
    await debugTransaction(page, button)
    await inspectStore(page, 42)

    await page.locator('#icon-panel div[plugin="udapp"]').click()
    await page.locator('[data-id="delete-delegation"]').click()
    await page.locator('[data-id="deleteDelegation-modal-footer-ok-react"]').click()
    await expect(page.locator('[data-id="delete-delegation"]')).not.toBeVisible()
    expect(await rpc(page, 'eth_getCode', authority)).toBe('0x')
    await debugTransaction(page, button)
    await inspectStore(page, 42)
  })

  test(`${fork}: debug signed access-list and authorization script transactions after revocation`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles('libs/remix-monad/examples/delegated-transactions.js')
    await page.locator('[data-id="treeViewLitreeViewItemdelegated-transactions.js"]').click()
    await page.locator('[data-id="run-script-dropdown-trigger"]').click()
    await page.locator('[data-id="run-with-ethers6-menu-item"]').click()
    const terminal = page.locator('[data-id="terminalJournal"]')
    if (!await terminal.isVisible()) await page.locator('[data-id="toggleBottomPanelIcon"]').click()
    const output = /typed-transactions-ok\s+(0x[\da-fA-F]{40})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})/
    await expect(terminal).toContainText(output, { timeout: 90_000 })
    const [, authority, delegated, access, failed] = (await terminal.innerText()).match(output)
    expect(await rpc(page, 'eth_getCode', authority)).toBe('0x')
    for (const [hash, value, type] of [[delegated, 42, '0x4'], [access, 77, '0x1']] as const) {
      expect((await rpc(page, 'eth_getTransactionByHash', hash)).type).toBe(type)
      await debugHash(page, hash)
      await inspectStore(page, value)
    }
    await debugHash(page, failed, 'Failed')
    await showOpcodes(page)
    for (let i = 0; i < 240 && !/\bREVERT\b/.test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
    await expect(currentOpcode(page)).toContainText('REVERT')
    await decodedValue(page, 99)
    expect(BigInt(await rpc(page, 'eth_getStorageAt', authority, '0x0'))).toBe(77n)
  })
}
