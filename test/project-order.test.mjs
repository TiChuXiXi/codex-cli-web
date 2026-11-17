import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {transform} from 'esbuild'
const {code}=await transform(await readFile(new URL('../web/src/page/projectOrder.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})
const {mergeProjectOrder,moveProject,sortProjects}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
const projects=names=>names.map(cwd=>({cwd}))
const names=items=>items.map(p=>p.cwd)

test('refresh and changes in activity preserve existing positions and append new projects',()=>{
 let order=mergeProjectOrder([],['a','b','c'])
 assert.deepEqual(names(sortProjects(projects(['c','a','b']),order)),['a','b','c'])
 order=mergeProjectOrder(order,['c','new','a','b'])
 assert.deepEqual(names(sortProjects(projects(['c','new','a','b']),order)),['a','b','c','new'])
})
test('moving up or down preserves hidden project positions and supports missing projects returning',()=>{
 const saved=mergeProjectOrder(['a','b','c','hidden'],['a','b','c'])
 assert.deepEqual(moveProject(saved,'c','a','before'),['c','a','b','hidden'])
 assert.deepEqual(moveProject(saved,'a','c','after'),['b','c','a','hidden'])
 assert.deepEqual(mergeProjectOrder(saved,['hidden','c','a','b']),saved)
 assert.deepEqual(names(sortProjects(projects(['hidden','c','b','a']),saved)),saved)
})
test('invalid moves do not change stored order',()=>{
 const order=['a','b','c']
 assert.strictEqual(moveProject(order,'a','a','after'),order)
 assert.strictEqual(moveProject(order,'unknown','a','before'),order)
 assert.strictEqual(moveProject(order,'a','missing','after'),order)
 assert.deepEqual(mergeProjectOrder(['a','a',''],['b','a']),['a','b'])
})
