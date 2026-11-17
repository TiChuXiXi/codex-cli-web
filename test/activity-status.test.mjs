import test from 'node:test'
import assert from 'node:assert/strict'
import {activityStatus, activityCounts} from '../web/src/activity-status.ts'
const item = values => ({id:'fixture',type:'commandExecution',...values})
test('unknown and partial history never claims all activity completed',()=>{
 assert.equal(activityStatus([]),null)
 assert.equal(activityStatus([item({})]),null)
 assert.equal(activityStatus([item({status:'completed'}),item({})]),null)
 assert.equal(activityStatus([item({status:'completed'})]),'completed')
})
test('failures remain visible while other work is running, including nonzero exits and MCP errors',()=>{
 for(const failure of [{status:'failed'},{status:'completed',exitCode:1},{status:'completed',result:{isError:true}},{error:{message:'broken'}}])
 assert.equal(activityStatus([item({status:'inProgress'}),item(failure)]),'failed')
})
test('active and interrupted activity are distinct from success',()=>{
 assert.equal(activityStatus([item({status:'completed'}),item({status:'inProgress'})]),'running')
 assert.equal(activityStatus([item({status:'cancelled'})]),'interrupted')
})

test('counts mixed outcomes per call, including unknown and partial runs',()=>{
 assert.deepEqual(activityCounts([
 item({status:'completed',exitCode:0}),
 item({type:'mcpToolCall',status:'completed',arguments:{paths:['a','b','c']}}),
 item({status:'completed',exitCode:2}),
 item({type:'mcpToolCall',status:'completed',result:{isError:true}}),
 item({status:'inProgress'}),item({status:'cancelled'}),item({})
 ]),{failed:2,completed:2,running:1,interrupted:1,unknown:1})
 assert.deepEqual(activityCounts([]),{failed:0,completed:0,running:0,interrupted:0,unknown:0})
})
