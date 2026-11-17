import test from 'node:test'
import assert from 'node:assert/strict'
import { createEpochGuard } from '../web/src/streamEpoch.ts'
test('SSE hello detects new instances even if their seq watermark has caught up',()=>{
  const guard=createEpochGuard()
  assert.equal(guard('a',10),false)
  assert.equal(guard('a',15),false)
  assert.equal(guard('b',20),true)
  assert.equal(guard('b',20),false)
  assert.equal(guard('b',3),true)
})
