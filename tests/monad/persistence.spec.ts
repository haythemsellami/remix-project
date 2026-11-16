import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { getAddress, Interface } from 'ethers'
import { test, openContract, transact, readValue } from './helpers'
import { Fork, rpc, chooseEnvironment, saving, savedFile, waitForSaved, reload, compileExisting, attach, deployAndStore, observe, observeState, expiredFilters, debugSaved } from './persistence-helpers'

test.describe.configure({ timeout: 180_000 })
const abi = new Interface(['event ValueChanged(uint256 value)'])

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: reload accounts, contracts and history, debug and continue`, async ({ page }) => {
    await chooseEnvironment(page, fork)
    await saving(page, true)
    const initialAccounts: string[] = await rpc(page, 'eth_accounts')
    await page.locator('[data-id="runTabSelectAccount"]').hover()
    await page.locator('[data-id="selected-account-kebab-menu"]').click()
    await page.locator('[data-id="newAccount"]').click()
    await expect.poll(async () => (await rpc(page, 'eth_accounts')).length).toBe(initialAccounts.length + 1)
    const added = (await rpc(page, 'eth_accounts')).at(-1)
    await page.locator('[data-id="runTabSelectAccount"]').click()
    await page.locator(`[data-id="${getAddress(added)}"]`).click()
    const contract = await deployAndStore(page, 42)
    const expected = await observe(page, contract)
    expect(expected.receipt.from.toLowerCase()).toBe(added.toLowerCase())
    const filters = [await rpc(page, 'eth_newFilter', { address: contract.address }), await rpc(page, 'eth_newBlockFilter')]
    await waitForSaved(page, fork)

    await reload(page, fork)
    expect(await observe(page, contract)).toEqual(expected)
    await expiredFilters(page, filters)
    await compileExisting(page)
    await debugSaved(page, contract.deployment)
    await debugSaved(page, contract.stored, 42)
    await attach(page, contract.address)
    await readValue(page, 42)
    await page.locator('[data-id="runTabSelectAccount"]').click()
    await page.locator(`[data-id="${getAddress(added)}"]`).click()
    const replacement = await rpc(page, 'eth_newFilter', { address: contract.address })
    await transact(page, 'store', '43')
    const delivered = await rpc(page, 'eth_getFilterChanges', replacement)
    expect(delivered).toHaveLength(1)
    expect(abi.parseLog(delivered[0]).args.value).toBe(43n)
    expect(await rpc(page, 'eth_getTransactionCount', added, 'latest')).toBe('0x3')
    await waitForSaved(page, fork)
    await reload(page, fork)
    expect(BigInt(await rpc(page, 'eth_getStorageAt', contract.address, '0x0', 'latest'))).toBe(43n)
    expect((await rpc(page, 'eth_getLogs', { address: contract.address, fromBlock: 'earliest' })).map(log => abi.parseLog(log).args.value)).toEqual([42n, 43n])
    await expiredFilters(page, [replacement])
  })

  test(`${fork}: disabled persistence preserves the saved file and starts fresh on reload`, async ({ page }) => {
    await chooseEnvironment(page, fork)
    const contract = await deployAndStore(page, 31)
    const expected = await observe(page, contract)
    await waitForSaved(page, fork)
    const digest = async () => createHash('sha256').update(await savedFile(page, fork) || '').digest('hex')
    const saved = await digest()
    await saving(page, false)
    await openContract(page)
    await transact(page, 'store', '32')
    const unsaved = (await rpc(page, 'eth_getBlockByNumber', 'latest', false)).transactions[0]
    expect(BigInt(await rpc(page, 'eth_getStorageAt', contract.address, '0x0', 'latest'))).toBe(32n)
    expect(await digest()).toBe(saved)
    await reload(page, fork)
    expect(await rpc(page, 'eth_blockNumber')).toBe('0x0')
    expect(await rpc(page, 'eth_getCode', contract.address, 'latest')).toBe('0x')
    expect(await rpc(page, 'eth_getTransactionCount', expected.accounts[0], 'latest')).toBe('0x0')
    expect(await rpc(page, 'eth_getTransactionReceipt', contract.stored)).toBeNull()
    expect(await rpc(page, 'eth_getTransactionReceipt', unsaved)).toBeNull()
    expect(await rpc(page, 'eth_getLogs', { fromBlock: 'earliest' })).toEqual([])
    expect(await digest()).toBe(saved)
    await saving(page, true)
    await reload(page, fork)
    expect(await observe(page, contract)).toEqual(expected)
    expect(await rpc(page, 'eth_getTransactionReceipt', unsaved)).toBeNull()
  })
}

test('Monad state survives switching between both forks and Ethereum Osaka', async ({ page }) => {
  const environments: { fork: Fork; contract: Awaited<ReturnType<typeof deployAndStore>>; expected: Awaited<ReturnType<typeof observeState>>; filter?: string }[] = []
  for (const [index, fork] of (['monad-ten', 'monad-next', 'osaka'] as const).entries()) {
    await chooseEnvironment(page, fork)
    if (environments.length) expect(await rpc(page, 'eth_getCode', environments[0].contract.address, 'latest')).toBe('0x')
    const contract = await deployAndStore(page, index + 51)
    const expected = await observeState(page, contract)
    const filter = fork === 'osaka' ? undefined : await rpc(page, 'eth_newBlockFilter')
    environments.push({ fork, contract, expected, filter })
    await waitForSaved(page, fork)
  }
  for (const { fork, contract, expected, filter } of environments.filter(environment => environment.fork !== 'osaka')) {
    await chooseEnvironment(page, fork)
    expect(await observeState(page, contract)).toEqual(expected)
    if (filter) await expiredFilters(page, [filter])
    for (const other of environments.filter(environment => environment.fork !== fork)) {
      expect(await rpc(page, 'eth_getTransactionReceipt', other.contract.stored)).toBeNull()
    }
  }
})
