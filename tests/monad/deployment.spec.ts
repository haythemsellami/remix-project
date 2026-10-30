import { expect, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { test, selectEnvironment, deploy, debugTransaction, showOpcodes, currentOpcode, step, openContract, transact, contractFunction } from './helpers'

test.use({ contractFile: 'FactoryDeployments.sol' })
// Deploy a linked factory, create two children, attach one, and debug four transactions.
test.describe.configure({ timeout: 240_000 })
const source = readFileSync('libs/remix-monad/examples/FactoryDeployments.sol', 'utf8')
const constructorLine = source.split('\n').findIndex(line => line.includes('value = initial;')) + 1
const libraryLine = source.split('\n').findIndex(line => line.includes('return input + 1;')) + 1
const salt = '0x' + '00'.repeat(31) + '7b'

async function selectCall(page: Page, type: string) {
  const collapsed = page.locator('.call-trace-expand-icon.fa-plus-square')
  for (let i = 0; i < 20 && await collapsed.count(); i++) await collapsed.first().click()
  // The call tree groups both creation instructions under its CREATE badge.
  const label = type === 'CREATE2' ? 'create' : type.toLowerCase()
  const call = page.locator('.call-trace-item').filter({ has: page.locator(`[data-id="call-trace-type-${label}"]`) })
  await expect(call).toHaveCount(1)
  await call.click()
  await showOpcodes(page)
  await expect(currentOpcode(page)).toContainText(type)
  return call
}

async function untilOpcode(page: Page, opcode: string) {
  for (let i = 0; i < 200 && !new RegExp(`\\b${opcode}\\b`).test(await currentOpcode(page).innerText()); i++) await step(page, 'forward')
  await expect(currentOpcode(page)).toContainText(opcode)
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

for (const fork of ['monad-next', 'monad-ten'] as const) {
  test(`${fork}: link a library, create children, attach at address and debug constructors and library calls`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'FactoryDeployments')
    await expect(page.locator('[data-id="terminalJournal"]')).toContainText('LinkedValues')
    let childAddress: string

    for (const [method, args, value, opcode] of [
      ['create', ['42'], 42, 'CREATE'], ['create2', [salt, '50'], 50, 'CREATE2']
    ] as const) {
      await test.step(`${opcode}: debug the child's constructor and decoded storage`, async () => {
        await openContract(page)
        const inputs = contractFunction(page, method).locator('input')
        for (const [index, argument] of args.entries()) await inputs.nth(index).fill(argument)
        const transaction = await transact(page, method)
        const lastChild = contractFunction(page, 'lastChild')
        await lastChild.getByRole('button', { name: 'Call', exact: true }).click()
        const result = lastChild.locator('[data-id="udapp_tree_value"]')
        if (childAddress) await expect(result).not.toContainText(childAddress)
        await expect(result).toContainText(/0x[0-9a-f]{40}/i)
        childAddress = (await result.innerText()).match(/0x[0-9a-f]{40}/i)[0]
        await debugTransaction(page, transaction)
        await selectCall(page, opcode)
        await step(page, 'forward')
        await expect(currentOpcode(page)).toHaveText(/^\s*0+\s+PUSH1\b.*/)
        await untilOpcode(page, 'SSTORE')
        await expect(page.locator(`#editorView .highlightLine${constructorLine}`).first()).toBeVisible()
        await step(page, 'forward')
        await decodedValue(page, value)
        await showOpcodes(page)
        await step(page, 'back')
        await expect(currentOpcode(page)).toContainText('SSTORE')
        await decodedValue(page, 0)
        await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
      })
    }

    await test.step('Attach the CREATE2 child through At Address and execute its linked library', async () => {
      await page.locator('#icon-panel div[plugin="udapp"]').click()
      await page.getByRole('tab', { name: 'Deploy', exact: true }).click()
      await page.locator('[data-id="contractDropdownToggle"]').click()
      await page.locator('[data-id="contractDropdownItem-FactoryChild"]').click()
      await page.getByRole('tab', { name: /^Deployed Contracts\b/ }).click()
      await page.locator('[data-id="addDeployedContract"]').click()
      await page.locator('[data-id="deployedContractAddressInput"]').fill(childAddress)
      await page.locator('[data-id="addDeployedContractButton"]').click()
      await expect(page.locator('[data-id="deployedContractsBadge"]')).toHaveText('2')
      if (!await page.locator('[data-id="functionList-1"]').isVisible()) await page.locator('[data-id="deployedContractItem-1"]').click()
      const row = (name: string) => page.locator('[data-id^="deployedContractItem-1-function-"]').filter({ has: page.locator(`[title="${name}"]`) })
      await row('value').getByRole('button', { name: 'Call', exact: true }).click()
      await expect(row('value').locator('[data-id="udapp_tree_value"]')).toContainText(/uint256: 50\b/)
      const buttons = page.locator('[data-shared="txLoggerDebugButton"]')
      const count = await buttons.count()
      await row('storeWithLibrary').locator('input').fill('76')
      await row('storeWithLibrary').getByRole('button', { name: 'Transact', exact: true }).click()
      await expect(buttons).toHaveCount(count + 1)
      const transaction = await buttons.last().getAttribute('data-id')
      await row('value').getByRole('button', { name: 'Call', exact: true }).click()
      await expect(row('value').locator('[data-id="udapp_tree_value"]')).toContainText(/uint256: 77\b/)
      await debugTransaction(page, transaction)
      const call = await selectCall(page, 'DELEGATECALL')
      await step(page, 'forward')
      const line = page.locator(`#editorView .highlightLine${libraryLine}`).first()
      for (let i = 0; i < 160 && !await line.isVisible(); i++) await step(page, 'forward')
      await expect(line).toBeVisible()
      await call.locator('button').filter({ has: page.locator('i.fa-step-forward') }).click()
      await expect(currentOpcode(page)).toContainText('RETURN')
      await step(page, 'forward')
      await untilOpcode(page, 'SSTORE')
      await step(page, 'forward')
      await decodedValue(page, 77)
      await showOpcodes(page)
      await step(page, 'back')
      await decodedValue(page, 50)
      await page.getByRole('button', { name: 'Stop debugging', exact: true }).click()
    })

    await test.step('Inspect a reverted child constructor while its factory succeeds', async () => {
      await openContract(page)
      const transaction = await transact(page, 'rejectCreate2', `"${salt}"`)
      await debugTransaction(page, transaction)
      const call = await selectCall(page, 'CREATE2')
      await step(page, 'forward')
      await call.locator('button').filter({ has: page.locator('i.fa-step-forward') }).click()
      await expect(currentOpcode(page)).toContainText('REVERT')
      await decodedValue(page, 99)
      await showOpcodes(page)
      await step(page, 'forward')
      await expect(currentOpcode(page)).not.toContainText('REVERT')
      await step(page, 'back')
      await expect(currentOpcode(page)).toContainText('REVERT')
      await decodedValue(page, 99)
    })
  })
}
