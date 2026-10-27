import { expect, Page } from '@playwright/test'
import { Interface } from 'ethers'
import { test, selectEnvironment, deploy, openContract, transact, readValue, debugTransaction, showOpcodes, currentOpcode, step } from './helpers'

const abi = new Interface(['function value() view returns (uint256)', 'function store(uint256)'])

// Use the existing public VM bridge to inspect the real worker; lifecycle actions use the UI.
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

for (const fork of ['monad-next', 'monad-ten'] as const) {
  test(`${fork}: bound history, save, reset and restore through the IDE`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page)
    const deploymentState = await rpc(page, 'eth_getStateDb')
    const deployment = deploymentState.blocks.at(-1).transactions[0]
    const address = (await rpc(page, 'eth_getTransactionReceipt', deployment)).contractAddress
    const [from] = await rpc(page, 'eth_accounts')

    await test.step('Evict old debugging data through repeated calls in the real worker', async () => {
      await page.evaluate(async ({ address, from, data }) => {
        const web3 = (window as any).__remixVM_web3
        for (let i = 0; i < 105; i++) await web3.send('eth_call', [{ from, to: address, data }, 'latest'])
      }, { address, from, data: abi.encodeFunctionData('value') })
      const state = await rpc(page, 'eth_getStateDb')
      expect(state.version).toBe(2)
      expect(state.history).toHaveLength(100)
      expect(state.history.reduce((total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength, 0)).toBeLessThanOrEqual(64 * 1024 * 1024)
      expect(state.history.some(([hash]) => hash === deployment)).toBe(false)
      expect((await rpc(page, 'eth_getTransactionReceipt', deployment)).status).toBe('0x1')
      await expect(rpc(page, 'debug_traceTransaction', deployment)).rejects.toThrow(/no longer retained/)
    })

    await openContract(page)
    const debugButton = await transact(page, 'store', '42')
    await readValue(page, 42)
    const saved = await rpc(page, 'eth_getStateDb')
    const stored = saved.blocks.at(-1).transactions[0]
    const snapshotName = `saved-${fork}`

    await test.step('Save a named state with recent debugging history', async () => {
      await changeProvider(page, async () => {
        await page.locator('[data-id="fork-state-icon"]').click()
        await page.locator('[data-id="forkInput"]').fill(snapshotName)
        await page.locator('[data-id="btnForkState"]').click()
        await expect(page.locator(`[data-id="selected-provider-vm-fs-${snapshotName}"]`)).toBeVisible()
      })
      const restored = await rpc(page, 'eth_getStateDb')
      expect(restored.engine).toBe(saved.engine)
      expect(restored.keys).toEqual(saved.keys)
      expect(restored.history).toEqual(saved.history)
    })

    await test.step('Reset the original environment and verify it stays empty when reopened', async () => {
      await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
      await page.locator('[data-id="delete-state-icon"]').click()
      await page.locator('[data-id="btnResetState"]').click()
      await expect(page.getByText('VM state reset successfully.', { exact: true })).toBeVisible()
      const other = fork === 'monad-next' ? 'monad-ten' : 'monad-next'
      await selectSavedOrLocal(page, 'Remix VM', `vm-${other}`)
      await selectSavedOrLocal(page, 'Remix VM', `vm-${fork}`)
      const reset = await rpc(page, 'eth_getStateDb')
      expect(reset.blocks).toHaveLength(1)
      expect(reset.executions).toEqual([])
      expect(reset.history).toEqual([])
      expect(await rpc(page, 'eth_getBalance', from, 'latest')).toBe('0x56bc75e2d63100000')
      expect(await rpc(page, 'eth_getTransactionCount', from, 'latest')).toBe('0x0')
      expect(await rpc(page, 'eth_getCode', address, 'latest')).toBe('0x')
      expect(await rpc(page, 'eth_getTransactionReceipt', stored)).toBeNull()
    })

    await test.step('Restore saved state and debug a retained storage write', async () => {
      await selectSavedOrLocal(page, 'Forked State', `vm-fs-${snapshotName}`)
      const restored = await rpc(page, 'eth_getStateDb')
      expect(restored.engine).toBe(saved.engine)
      expect(restored.history).toEqual(saved.history)
      expect(await rpc(page, 'eth_getStorageAt', address, '0x0', 'latest')).toBe('0x' + '2a'.padStart(64, '0'))
      await debugTransaction(page, debugButton)
      await showOpcodes(page)
      for (let i = 0; i < 80 && !/\bSSTORE\b/.test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
      await expect(currentOpcode(page)).toContainText('SSTORE')
      await step(page, 'forward')
      await page.getByRole('button', { name: 'State & Locals', exact: true }).click()
      const state = page.locator('[data-id="solidityState"]')
      for (const key of ['state', 'value']) {
        const toggle = state.locator(`[data-id="${key}-expand-icon"]`)
        await expect(toggle).toBeVisible()
        if ((await toggle.getAttribute('class')).includes('fa-plus-square')) await toggle.click()
      }
      await expect(state.locator('[data-id="value-json-nested"] [data-id="value-json-value"]')).toHaveText('"42"')
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
      const hash = await rpc(page, 'eth_sendTransaction', { from, to: address, data: abi.encodeFunctionData('store', [43]), gas: '0x186a0' })
      expect((await rpc(page, 'eth_getTransactionReceipt', hash)).status).toBe('0x1')
      expect(await rpc(page, 'eth_getStorageAt', address, '0x0', 'latest')).toBe('0x' + '2b'.padStart(64, '0'))
    })
  })
}
