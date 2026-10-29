import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, deploy, debugTransaction, showOpcodes, currentOpcode, seekOpcode, step, openContract, transact, readValue, contractFunction } from './helpers'

test.use({ contractFile: 'PrecompileCalls.sol' })
// Compile, deploy and navigate several precompile transactions in each scenario.
test.describe.configure({ timeout: 300_000 })
const source = readFileSync('libs/remix-monad/examples/PrecompileCalls.sol', 'utf8')
const callLine = source.split('\n').findIndex(line => line.includes('(success, output) = target.staticcall')) + 1
const hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

async function selectFunction(page: Page, name: string) {
  const collapsed = page.locator('.call-trace-expand-icon.fa-plus-square')
  for (let i = 0; i < 20 && await collapsed.count(); i++) await collapsed.first().click()
  const row = page.locator('.call-trace-item').filter({ has: page.locator('.method-name', { hasText: new RegExp(`^${name}$`) }) })
  await expect(row).toHaveCount(1)
  await row.click()
  return row
}

async function reachPrecompile(page: Page) {
  await showOpcodes(page)
  await seekOpcode(page, 'STATICCALL')
  await expect(page.locator(`#editorView .highlightLine${callLine}`).first()).toBeVisible()
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

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: debug precompile return data, rejected inputs and gas exhaustion`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'PrecompileCalls')

    for (const [method, output, success] of [
      ['hashAndStore', '0x' + hash, true], ['verifyP256', '0x' + '0'.repeat(63) + '1', true],
      ['invalidPoint', '0x', false], ['insufficientGas', '0x', false]
    ] as const) {
      await test.step(method, async () => {
        await openContract(page)
        const transaction = await transact(page, method)
        await readValue(page, success ? 42 : 11)
        const result = contractFunction(page, 'result')
        await result.getByRole('button', { name: 'Call', exact: true }).click()
        await expect(result.locator('[data-id="udapp_tree_value"]')).toHaveText(`0:bytes: ${output}`)
        const status = contractFunction(page, 'lastSuccess')
        await status.getByRole('button', { name: 'Call', exact: true }).click()
        await expect(status.locator('[data-id="udapp_tree_value"]')).toContainText(`bool: ${success}`)
        await debugTransaction(page, transaction)
        const caller = await selectFunction(page, method)
        await expect(page.locator('[data-id="call-trace-type-staticcall"]')).toHaveCount(0)
        await reachPrecompile(page)
        await expect(page.locator(`#editorView .highlightLine${callLine}`).first()).toBeVisible()
        await step(page, 'forward')
        await expect(currentOpcode(page)).not.toContainText('STATICCALL')
        await step(page, 'back')
        await expect(currentOpcode(page)).toContainText('STATICCALL')
        await expect(page.locator(`#editorView .highlightLine${callLine}`).first()).toBeVisible()
        await step(page, 'forward')
        if (success) {
          await seekOpcode(page, 'RETURNDATACOPY')
          await step(page, 'forward')
          const toggle = page.locator('[data-id="memory-expand-icon"]')
          if ((await toggle.getAttribute('class')).includes('fa-plus-square')) await toggle.click()
          await expect(page.locator('[data-id="memory-json-nested"]')).toContainText(output.slice(2))
        }
        await caller.locator('button').filter({ has: page.locator('i.fa-step-forward') }).click()
        await decodedValue(page, success ? 42 : 11)
        await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
      })
    }
  })

  test(`${fork}: debug caller rollback after precompile failure`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'PrecompileCalls')
    await openContract(page)
    await transact(page, 'invalidPoint')
    await readValue(page, 11)
    await test.step('A caller revert rolls back state while its trace remains inspectable', async () => {
      const contracts = page.locator('#udappDeployedContractsComponent')
      await contracts.getByText('auto', { exact: true }).click()
      const gas = contracts.locator('.position-relative').filter({ has: page.getByText('custom', { exact: true }) })
      await expect(gas.getByRole('spinbutton')).toHaveValue('3000000')
      const transaction = await transact(page, 'requireValidPoint')
      await readValue(page, 11)
      await debugTransaction(page, transaction, 'Failed')
      await selectFunction(page, 'requireValidPoint')
      await reachPrecompile(page)
      await step(page, 'forward')
      await decodedValue(page, 99)
      await showOpcodes(page)
      await seekOpcode(page, 'REVERT')
      await decodedValue(page, 99)
    })
  })
}
