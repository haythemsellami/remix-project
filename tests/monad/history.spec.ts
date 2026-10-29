import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { Interface } from 'ethers'
import { test, selectEnvironment, showOpcodes, currentOpcode, step } from './helpers'

test.use({ contractFile: 'HistoricalCalls.sol', scriptRunner: true })
test.describe.configure({ timeout: 300_000 })
const source = readFileSync('libs/remix-monad/examples/HistoricalCalls.sol', 'utf8')
const lineFor = text => source.split('\n').findIndex(line => line.includes(text)) + 1
const simulateLine = source.split('\n').findIndex((line, index) => index > 10 && line.includes('value = next')) + 1
const abi = new Interface(['function read() view returns (uint256,uint256,uint256,bytes32)', 'function store(uint256)'])
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

async function inspect(page: Page, hash: string, failed: boolean) {
  const input = page.locator('[data-id="debuggerTransactionInput"]')
  if (!await input.isVisible()) await page.locator('#icon-panel div[plugin="debugger"]').click()
  await input.fill(hash)
  await page.getByRole('button', { name: 'Start debugging', exact: true }).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText(failed ? 'Failed' : 'Success')
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
  await showOpcodes(page)
  for (let i = 0; i < 220 && !/\bSSTORE\b/.test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
  await expect(currentOpcode(page)).toContainText('SSTORE')
  const line = failed ? lineFor('value = 99') : simulateLine
  await expect(page.locator(`#editorView .highlightLine${line}`).first()).toBeVisible()
  await decodedValue(page, 1)
  await showOpcodes(page)
  await step(page, 'forward')
  await decodedValue(page, failed ? 99 : 11)
  await showOpcodes(page)
  await step(page, 'back')
  await expect(currentOpcode(page)).toContainText('SSTORE')
  await decodedValue(page, 1)
  await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: script historical calls retain source and storage debugging after restore`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles('libs/remix-monad/examples/historical-calls.js')
    await page.locator('[data-id="treeViewLitreeViewItemhistorical-calls.js"]').click()
    await page.locator('[data-id="run-script-dropdown-trigger"]').click()
    await page.locator('[data-id="run-with-ethers6-menu-item"]').click()
    const terminal = page.locator('[data-id="terminalJournal"]')
    if (!await terminal.isVisible()) await page.locator('[data-id="toggleBottomPanelIcon"]').click()
    const output = /historical-calls-ok\s+(0x[\da-fA-F]{40})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})/
    await expect(terminal).toContainText(output, { timeout: 90_000 })
    const [, address, blockA, blockB, success, failed] = (await terminal.innerText()).match(output)
    const saved = await rpc(page, 'eth_getStateDb')
    const snapshotName = `history-${fork}`
    await page.locator('#icon-panel div[plugin="udapp"]').click()
    // Script deployments populate the UI asynchronously; finish receipt lookup before replacing the VM worker.
    await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('1')
    await changeProvider(page, async () => {
      await page.locator('[data-id="fork-state-icon"]').click()
      await page.locator('[data-id="forkInput"]').fill(snapshotName)
      await page.locator('[data-id="btnForkState"]').click()
      await expect(page.locator(`[data-id="selected-provider-vm-fs-${snapshotName}"]`)).toBeVisible()
    })
    // The provider changes before the save action finishes updating the environment selector.
    await expect(page.locator('[data-id="forkInput"]')).not.toBeVisible()
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
    await page.locator('[data-id="delete-state-icon"]').click()
    await page.locator('[data-id="btnResetState"]').click()
    await expect(page.getByText('VM state reset successfully.', { exact: true })).toBeVisible()
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork === 'monad-ten' ? 'monad-next' : 'monad-ten'}`)
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
    expect(await rpc(page, 'eth_blockNumber')).toBe('0x0')
    expect(await rpc(page, 'eth_getCode', address)).toBe('0x')
    await selectSavedOrLocal(page, 'Forked State', `vm-fs-${snapshotName}`)
    const restored = await rpc(page, 'eth_getStateDb')
    expect(restored.engine).toBe(saved.engine)
    expect(restored.executions).toEqual(saved.executions)
    const [from] = await rpc(page, 'eth_accounts')
    for (const [hash, value] of [[blockA, 1n], [blockB, 2n]] as const) {
      const block = await rpc(page, 'eth_getBlockByHash', hash, false)
      const result = await rpc(page, 'eth_call', { from, to: address, data: abi.encodeFunctionData('read') }, { blockHash: hash, requireCanonical: true })
      expect(Array.from(abi.decodeFunctionResult('read', result))).toEqual([value, BigInt(block.number), BigInt(block.timestamp), block.parentHash])
    }
    await inspect(page, success, false)
    await inspect(page, failed, true)
    expect(BigInt(await rpc(page, 'eth_getStorageAt', address, '0x0'))).toBe(2n)
    expect((await rpc(page, 'eth_getStateDb')).engine).toBe(saved.engine)
    const stored = await rpc(page, 'eth_sendTransaction', { from, to: address, data: abi.encodeFunctionData('store', [3]), gas: '0x186a0' })
    expect((await rpc(page, 'eth_getTransactionReceipt', stored)).status).toBe('0x1')
    const earlier = await rpc(page, 'eth_call', { from, to: address, data: abi.encodeFunctionData('read') }, { blockHash: blockA })
    expect(abi.decodeFunctionResult('read', earlier)[0]).toBe(1n)
    expect(BigInt(await rpc(page, 'eth_getStorageAt', address, '0x0'))).toBe(3n)
  })
}
