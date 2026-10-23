import { isMediaUrl, MAX_INPUT_BYTES } from './media.js';
export function createBudget(limit=MAX_INPUT_BYTES) { return {limit,used:0}; }
function abort(signal) { if(signal?.aborted) throw new DOMException('Aborted','AbortError'); }
function responseLength(response) {
  const declared = response.headers.get('Content-Length');
  let length = declared === null ? undefined : Number(declared);
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new Error('媒体长度无效，无法确认文件完整。');
  if (response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
    const completeLength = Number(range?.[2]);
    if (!range || !Number.isSafeInteger(completeLength) || completeLength <= 0 || Number(range[1]) + 1 !== completeLength
      || (length !== undefined && length !== completeLength)) throw new Error('服务器只返回了部分媒体数据，无法保存完整文件。');
    length = completeLength;
  }
  return length;
}
export async function fetchInput(input,{budget=createBudget(),signal,fetchImpl=fetch,onProgress=()=>{}}={}) {
  let lastError;
  for(const url of input.urls??[]) {
    abort(signal);
    if(!isMediaUrl(url))throw new Error('不允许的媒体地址。');
    const start=budget.used;let reader,response;
    try {
      response=await fetchImpl(url,{signal,credentials:'omit',redirect:'error'});
      if(!response.ok)throw new Error(`媒体下载失败（HTTP ${response.status}），请刷新资源后重试。`);
      if(/text\/|json/i.test(response.headers.get('Content-Type')??''))throw new Error('服务器返回的不是媒体格式，请刷新或检查登录状态。');
      const length=responseLength(response)??0;
      if(length+start>budget.limit) { await response.body?.cancel();throw new RangeError('文件大小超过浏览器处理预算，请使用原始轨分别下载。'); }
      if(!response.body)throw new Error('媒体响应为空。');
      reader=response.body.getReader();const chunks=[];let total=0;
      while(true) {
        abort(signal); const {done,value}=await reader.read();if(done)break;
        if(start+total+value.byteLength>budget.limit)throw new RangeError('文件大小超过浏览器处理预算，请使用原始轨分别下载。');
        total+=value.byteLength;budget.used=start+total;chunks.push(value);onProgress(total,length);
      }
      if(!total || length&&total!==length)throw new Error('媒体文件不完整，请刷新资源后重试。');
      const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
      return data;
    } catch(e) {
      budget.used=start;lastError=e;try {if(reader)await reader.cancel();else await response?.body?.cancel();}catch{}
      if(signal?.aborted||e.name==='AbortError'||e instanceof RangeError)throw e;
    } finally {try{reader?.releaseLock();}catch{}}
  }
  throw lastError??new Error('没有可用的媒体地址。');
}

async function waitOrAbort(operation, signal) {
  if (!signal) return operation;
  let listener;
  const cancelled = new Promise((resolve, reject) => {
    listener = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}

/** Download an original track directly into a transactional writable (e.g.
 * OPFS). Each backup gets a fresh file transaction; only one chunk is retained
 * while waiting for write backpressure. No in-memory processing budget applies.
 */
export async function streamInput(input, { openWritable, signal, fetchImpl = fetch, onProgress = () => {} } = {}) {
  if (typeof openWritable !== 'function') throw new TypeError('缺少原始轨文件写入器。');
  let lastError;
  for (const url of input.urls ?? []) {
    abort(signal);
    if (!isMediaUrl(url)) throw new Error('不允许的媒体地址。');
    let writable, reader, response;
    try {
      writable = await openWritable();
      abort(signal);
      response = await waitOrAbort(fetchImpl(url, { signal, credentials: 'omit', redirect: 'error' }), signal);
      abort(signal);
      if (!response.ok) throw new Error(`媒体下载失败（HTTP ${response.status}），请刷新资源后重试。`);
      if (/text\/|json/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('服务器返回的不是媒体格式，请刷新或检查登录状态。');
      const length = responseLength(response);
      if (!response.body) throw new Error('媒体响应为空。');
      reader = response.body.getReader();
      let total = 0;
      while (true) {
        abort(signal);
        const { done, value } = await waitOrAbort(reader.read(), signal);
        if (done) break;
        abort(signal);
        if (length !== undefined && total + value.byteLength > length) throw new Error('媒体文件长度不完整或与响应不符，请刷新资源后重试。');
        await waitOrAbort(writable.write(value), signal);
        total += value.byteLength;
        onProgress(total, length ?? 0);
      }
      abort(signal);
      if (!total || (length !== undefined && total !== length)) throw new Error('媒体文件不完整，请刷新资源后重试。');
      await waitOrAbort(writable.close(), signal);
      abort(signal);
      return total;
    } catch (error) {
      lastError = error;
      try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
      try { await writable?.abort(); } catch {}
      if (signal?.aborted || error.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
      if (error.name === 'QuotaExceededError') {
        const diskError = new Error('磁盘空间不足，无法保存原始轨。请释放磁盘空间后重试。', { cause: error });
        diskError.name = 'QuotaExceededError';
        throw diskError;
      }
    } finally {
      try { reader?.releaseLock(); } catch {}
    }
  }
  throw lastError ?? new Error('没有可用的媒体地址。');
}
