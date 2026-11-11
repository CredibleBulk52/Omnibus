'use strict';
// Each callback must be idempotent for operation ID + revision, preserve manual
// relationships, and reject on failure. A crash between effect and acknowledgment
// can repeat it; claiming exactly-once external effects would be incorrect.
async function runBookFollowups({db,journal,handle,handlers,signal}) {
  const record=db.prepare('SELECT * FROM metadata_book_followups WHERE operation_id=?').get(handle.operationId);
  if(!record)throw new Error('Missing finalization follow-ups');
  const payload=JSON.parse(record.payload);
  for(const name of payload.order) if(typeof handlers?.[name]!=='function')throw new TypeError(`Missing follow-up handler: ${name}`);
  for(const name of payload.order) {
    const current=JSON.parse(db.prepare('SELECT payload FROM metadata_book_followups WHERE operation_id=?').get(handle.operationId).payload);
    if((current.completed||[]).includes(name))continue;
    journal.assertOwned(handle);
    if(signal?.aborted)throw Object.assign(new Error('Reprocessing cancelled'),{code:'ARCHIVE_CANCELLED'});
    await handlers[name]({...current,operationId:handle.operationId});
    journal.finalizedTransaction(handle,(connection)=>{
      const latest=JSON.parse(connection.prepare('SELECT payload FROM metadata_book_followups WHERE operation_id=?').get(handle.operationId).payload);
      latest.completed=[...new Set([...(latest.completed||[]),name])];
      connection.prepare('UPDATE metadata_book_followups SET payload=?,state=? WHERE operation_id=?').run(JSON.stringify(latest),latest.order.every(n=>latest.completed.includes(n))?'complete':'pending',handle.operationId);
    });
  }
}
module.exports={runBookFollowups};
