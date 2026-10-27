import { expect } from '@playwright/test'
import { test, selectEnvironment, deploy, openContract, transact, readValue } from './helpers'

test.use({ contractFile: 'ConsoleDemo.sol' })

for (const fork of ['monad-next', 'monad-ten'] as const) {
  test(`${fork}: show contract console output in the terminal`, async ({ page }) => {
    await selectEnvironment(page, fork)
    await deploy(page, 'ConsoleDemo')
    await openContract(page)
    await transact(page, 'logValues')
    await readValue(page, 42)
    const terminal = page.locator('[data-id="terminalJournal"]')
    await expect(terminal).toContainText('monad-terminal')
    await expect(terminal).toContainText('42 true')
  })
}
