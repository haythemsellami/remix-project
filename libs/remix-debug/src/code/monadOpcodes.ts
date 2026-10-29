/** MIP-7 extension selectors, active only in MonadNext. */
const MONAD_OPCODES = [
  { name: 'CALLSTACKDEPTH', in: 0, out: 1 },
  { name: 'CALLERN', in: 1, out: 1 }
]

export function monadOpcodeAt (raw: ArrayLike<number>, pc: number, hardfork: string) {
  if (hardfork !== 'monad-next' || raw[pc] !== 0xae) return undefined
  return MONAD_OPCODES[raw[pc + 1]]
}

export function monadOpcodeByName (name: string) {
  return MONAD_OPCODES.find(opcode => opcode.name === name)
}
