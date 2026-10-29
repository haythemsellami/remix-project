import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { Interface } from 'ethers'
import { test, selectEnvironment, showOpcodes, currentOpcode, seekOpcode, step } from './helpers'

test.use({ contractFile: 'EventQueries.sol', scriptRunner: true })
test.describe.configure({ timeout: 180_000 })
const source = readFileSync('libs/remix-monad/examples/EventQueries.sol', 'utf8')
const abi = new Interface(['event Updated(address indexed sender,uint256 indexed key,uint256 value,string note)', 'function store(uint256,uint256,string)'])
const rpc = (page: Page, method: string, ...params: any[]) => page.evaluate(
  ({ method, params }) => (window as any).__remixVM_web3.send(method, params), { method, params }
)

async function changeProvider(page: Page, action: () => Promise<void>) {
  const previous = await page.evaluateHandle(() => (window as any).__remixVM_web3)
  try {
    await action()
    await page.waitForFunction(previous => (window as any).__remixVM_web3 !== previous, previous)
  } finally { await previous.dispose() }
}

async function selectSavedOrLocal(page: Page, category: string, name: string) {
  await changeProvider(page, async () => {
    const selector = page.locator('[data-id="settingsSelectEnvOptions"]')
    if (!(await selector.innerText()).includes(category)) {
      await selector.click()
      await page.locator(`[data-id="dropdown-item-${category.replace(/ /g, '_')}"]`).click()
      await expect(selector).toContainText(category)
    }
    await page.locator('[data-id="settingsSelectEnvCategoryOptions"]').click()
    await page.locator(`[data-id="dropdown-item-${name}"]`).click()
    await expect(page.locator(`[data-id="selected-provider-${name}"]`)).toBeVisible()
  })
}

async function inspect(page: Page, hash: string, failed: boolean) {
  const input = page.locator('[data-id="debuggerTransactionInput"]')
  if (!await input.isVisible()) await page.locator('#icon-panel div[plugin="debugger"]').click()
  await input.fill(hash)
  await page.getByRole('button', { name: 'Start debugging', exact: true }).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText(failed ? 'Failed' : 'Success')
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
  await showOpcodes(page)
  await seekOpcode(page, 'LOG3')
  const fragment = failed ? 'emit Updated(msg.sender, key, 99' : 'emit Updated(msg.sender, key, next'
  const line = source.split('\n').findIndex(line => line.includes(fragment)) + 1
  await expect(page.locator(`#editorView .highlightLine${line}`).first()).toBeVisible()
  await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
  const state = page.locator('[data-id="solidityState"]')
  for (const key of ['state', 'value']) {
    const toggle = state.locator(`[data-id="${key}-expand-icon"]`)
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute('class')).includes('fa-plus-square')) await toggle.click()
  }
  await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText(failed ? '"99"' : '"11"')
  await showOpcodes(page)
  await step(page, 'forward')
  await step(page, 'back')
  await expect(currentOpcode(page)).toContainText('LOG3')
  await expect(page.locator(`#editorView .highlightLine${line}`).first()).toBeVisible()
  await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: script event listeners and saved event debugging`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles('libs/remix-monad/examples/event-listeners.js')
    await page.locator('[data-id="treeViewLitreeViewItemevent-listeners.js"]').click()
    await page.locator('[data-id="run-script-dropdown-trigger"]').click()
    await page.locator('[data-id="run-with-ethers6-menu-item"]').click()
    const terminal = page.locator('[data-id="terminalJournal"]')
    if (!await terminal.isVisible()) await page.locator('[data-id="toggleBottomPanelIcon"]').click()
    const output = /events-workflow-ok\s+(0x[\da-fA-F]{40})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]+)\s+(0x[\da-fA-F]+)/
    await expect(terminal).toContainText(output, { timeout: 90_000 })
    const [, address, success, failed, filter, blocks] = (await terminal.innerText()).match(output)
    const query = { address, fromBlock: 'earliest', topics: [abi.getEvent('Updated').topicHash]}
    const logs = await rpc(page, 'eth_getLogs', query)
    expect(logs.map(log => abi.parseLog(log).args.value)).toEqual([11n, 22n, 33n])
    expect(await rpc(page, 'eth_getFilterLogs', filter)).toEqual(logs)
    expect(await rpc(page, 'eth_getFilterChanges', filter)).toEqual([])
    const snapshotName = `events-${fork}`
    await page.locator('#icon-panel div[plugin="udapp"]').click()
    await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('1')
    await changeProvider(page, async () => {
      await page.locator('[data-id="fork-state-icon"]').click()
      await page.locator('[data-id="forkInput"]').fill(snapshotName)
      await page.locator('[data-id="btnForkState"]').click()
      await expect(page.locator(`[data-id="selected-provider-vm-fs-${snapshotName}"]`)).toBeVisible()
    })
    await expect(page.locator('[data-id="forkInput"]')).not.toBeVisible()
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
    await page.locator('[data-id="delete-state-icon"]').click()
    await page.locator('[data-id="btnResetState"]').click()
    await expect(page.getByText('VM state reset successfully.', { exact: true })).toBeVisible()
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork === 'monad-ten' ? 'monad-next' : 'monad-ten'}`)
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
    expect(await rpc(page, 'eth_getLogs', query)).toEqual([])
    expect(await rpc(page, 'eth_uninstallFilter', filter)).toBe(false)
    await selectSavedOrLocal(page, 'Forked State', `vm-fs-${snapshotName}`)
    expect(await rpc(page, 'eth_getLogs', query)).toEqual(logs)
    for (const id of [filter, blocks]) {
      await expect(rpc(page, 'eth_getFilterChanges', id)).rejects.toThrow(/Filter not found/)
    }
    const replacement = await rpc(page, 'eth_newFilter', query)
    expect(replacement).not.toBe(filter)
    expect(await rpc(page, 'eth_getFilterChanges', replacement)).toEqual([])
    await inspect(page, success, false)
    await inspect(page, failed, true)
    expect((await rpc(page, 'eth_getTransactionReceipt', failed)).logs).toEqual([])
    expect(BigInt(await rpc(page, 'eth_getStorageAt', address, '0x0'))).toBe(33n)
    const [from] = await rpc(page, 'eth_accounts')
    const next = await rpc(page, 'eth_sendTransaction', { from, to: address, data: abi.encodeFunctionData('store', [6, 66, 'restored']), gas: '0x493e0' })
    const delivered = await rpc(page, 'eth_getFilterChanges', replacement)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].transactionHash).toBe(next)
    expect(abi.parseLog(delivered[0]).args.value).toBe(66n)
    expect(await rpc(page, 'eth_getFilterChanges', replacement)).toEqual([])
    expect(await rpc(page, 'eth_uninstallFilter', replacement)).toBe(true)
  })
}
