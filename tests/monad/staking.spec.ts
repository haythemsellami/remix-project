import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { Interface, parseEther } from 'ethers'
import { test, selectEnvironment, showOpcodes, currentOpcode, step } from './helpers'

test.use({ contractFile: 'StakingDemo.sol', scriptRunner: true })
test.describe.configure({ timeout: 420_000 })
const source = readFileSync('libs/remix-monad/examples/StakingDemo.sol', 'utf8')
const callLine = source.split('\n').findIndex(line => line.includes('STAKING.call{value:')) + 1
const staking = '0x0000000000000000000000000000000000001000'
const abi = new Interface(['function getEpoch() returns (uint64,bool)'])
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

async function debugHash(page: Page, hash: string, status: string) {
  const input = page.locator('[data-id="debuggerTransactionInput"]')
  if (!await input.isVisible()) await page.locator('#icon-panel div[plugin="debugger"]').click()
  await input.fill(hash)
  await page.getByRole('button', { name: 'Start debugging', exact: true }).click()
  await expect(page.locator('[data-id="txStatus"]')).toHaveText(status)
  await expect(page.locator('[data-id="btnStepBack"]')).toBeEnabled()
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

async function inspectCall(page: Page, method: string, value: number) {
  const collapsed = page.locator('.call-trace-expand-icon.fa-plus-square')
  for (let i = 0; i < 20 && await collapsed.count(); i++) await collapsed.first().click()
  const scope = name => page.locator('.call-trace-item').filter({ has: page.locator('.method-name', { hasText: new RegExp(`^${name}$`) }) })
  await expect(scope(method)).toHaveCount(1)
  await scope(method).click()
  // Use source steps through the internal Solidity helper, then instruction steps at CALL.
  await showOpcodes(page)
  await page.locator('.json-line').filter({ has: page.locator('.json-key', { hasText: /^opcode$/ }) }).locator('i').click()
  await expect(page.locator('.opcodes-container')).not.toBeVisible()
  const line = page.locator(`#editorView .highlightLine${callLine}:visible`).first()
  const highlight = page.locator('#editorView [class*="highlightLine"]').first()
  await expect(highlight).toBeAttached()
  for (let i = 0; i < 80 && !await line.isVisible(); i++) {
    const header = page.locator('[data-id="callTraceHeader"]')
    const before = await header.innerText()
    await page.locator('[data-id="btnStepInto"]').click()
    await expect(header).not.toHaveText(before)
    await expect(highlight).toBeAttached()
  }
  await expect(line).toBeVisible()
  await showOpcodes(page)
  for (let i = 0; i < 160 && !/\bCALL\b/.test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
  await expect(currentOpcode(page)).toContainText(/\bCALL\b/)
  await expect(page.locator(`#editorView .highlightLine${callLine}`).first()).toBeVisible()
  await expect(page.locator('.call-trace-item .method-name')).toHaveCount(1)
  await step(page, 'forward')
  await expect(currentOpcode(page)).not.toContainText(/\bCALL\b/)
  await step(page, 'back')
  await expect(currentOpcode(page)).toContainText(/\bCALL\b/)
  await expect(page.locator(`#editorView .highlightLine${callLine}`).first()).toBeVisible()
  await scope(method).locator('button').filter({ has: page.locator('i.fa-step-forward') }).click()
  await decodedValue(page, value)
  await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: staking script lifecycle, saved-state restore and source debugging`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await page.locator('[data-id="fileExplorerLocalFileSystemUpload"]').setInputFiles('libs/remix-monad/examples/staking-workflow.js')
    await page.locator('[data-id="treeViewLitreeViewItemstaking-workflow.js"]').click()
    await page.locator('[data-id="run-script-dropdown-trigger"]').click()
    await page.locator('[data-id="run-with-ethers6-menu-item"]').click()
    const terminal = page.locator('[data-id="terminalJournal"]')
    if (!await terminal.isVisible()) await page.locator('[data-id="toggleBottomPanelIcon"]').click()
    const output = /staking-workflow-ok\s+(0x[\da-fA-F]{40})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})\s+(0x[\da-fA-F]{64})/
    await expect(terminal).toContainText(output, { timeout: 90_000 })
    const [, address, staked, early, withdrawn, rejected] = (await terminal.innerText()).match(output)
    expect(BigInt(await rpc(page, 'eth_getBalance', address))).toBe(parseEther('10000005'))
    const saved = await rpc(page, 'eth_getStateDb')
    expect(saved.stakingTransitions).toHaveLength(7)
    const snapshotName = `staking-${fork}`
    await page.locator('#icon-panel div[plugin="udapp"]').click()
    await changeProvider(page, async () => {
      await page.locator('[data-id="fork-state-icon"]').click()
      await page.locator('[data-id="forkInput"]').fill(snapshotName)
      await page.locator('[data-id="btnForkState"]').click()
      await expect(page.locator(`[data-id="selected-provider-vm-fs-${snapshotName}"]`)).toBeVisible()
    })
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
    await page.locator('[data-id="delete-state-icon"]').click()
    await page.locator('[data-id="btnResetState"]').click()
    await expect(page.getByText('VM state reset successfully.', { exact: true })).toBeVisible()
    const other = fork === 'monad-next' ? 'monad-ten' : 'monad-next'
    await selectSavedOrLocal(page, 'Remix VM', `vm-${other}`)
    await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
    expect((await rpc(page, 'eth_getStateDb')).stakingTransitions).toEqual([])
    expect(await rpc(page, 'eth_getBalance', staking)).toBe('0x0')
    await selectSavedOrLocal(page, 'Forked State', `vm-fs-${snapshotName}`)
    const restored = await rpc(page, 'eth_getStateDb')
    expect(restored.engine).toBe(saved.engine)
    expect(restored.stakingTransitions).toEqual(saved.stakingTransitions)
    expect(restored.executions).toEqual(saved.executions)
    const [from] = await rpc(page, 'eth_accounts')
    const readEpoch = await rpc(page, 'eth_call', { from, to: staking, data: abi.encodeFunctionData('getEpoch') })
    expect(Array.from(abi.decodeFunctionResult('getEpoch', readEpoch))).toEqual([3n, false])
    for (const [hash, method, status, value] of [
      [staked, 'stake', 'Success', 42], [early, 'withdraw', 'Success', 11],
      [withdrawn, 'withdraw', 'Success', 42], [rejected, 'rejectAfterStake', 'Failed', 42]
    ] as const) {
      await test.step(`debug ${method} ${hash}`, async () => {
        await debugHash(page, hash, status)
        await inspectCall(page, method, value)
      })
    }
    expect(BigInt(await rpc(page, 'eth_getStorageAt', address, '0x0'))).toBe(42n)
    await rpc(page, 'monad_stakingTransition', { kind: 'snapshot' })
    await rpc(page, 'monad_stakingTransition', { kind: 'epochChange', epoch: '0x4' })
    expect((await rpc(page, 'eth_getStateDb')).stakingTransitions).toHaveLength(9)
  })
}
