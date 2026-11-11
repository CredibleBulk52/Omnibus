// A failed response must not imply that a write did or did not happen.
// Never automatically repeat a mutation after a lost response.
export async function requestMetadata(url, options) {
  const writing=options?.method && options.method!=='GET';
  const uncertain=writing?' The action may already have run. Refresh status before trying the action again.':'';
  let response,body;
  try {
    response=await fetch(url,options);
    body=await response.text();
  } catch {
    throw new Error('The connection to Omnibus was interrupted. Try refreshing status in a moment.'+uncertain);
  }
  const requestId=response.headers?.get?.('X-Omnibus-Request-ID');
  const reference=requestId?' Reference: '+requestId+'.':'';
  let data;
  try { data=JSON.parse(body); } catch { /* Empty responses and proxy HTML are not JSON. */ }
  if(!response.ok){
    if(response.status===401)throw new Error('Your session has expired. Please sign in again.');
    if(response.status===403)throw new Error('You need administrator access to use this action.');
    const message=typeof data?.error==='string'?data.error:
      response.status>=500?'Omnibus is temporarily unavailable. Try refreshing status in a moment.':
      'Omnibus could not complete this request.';
    throw new Error(message+' (HTTP '+response.status+')'+reference+(response.status>=500?uncertain:''));
  }
  if(!data || typeof data!=='object' || Array.isArray(data)){
    throw new Error('Omnibus returned an empty or incomplete response. Try refreshing status in a moment.'+reference+uncertain);
  }
  return data;
}
