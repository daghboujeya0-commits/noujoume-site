// netlify/functions/firestoreProxy.js
// Fait transiter toutes les lectures/écritures Firestore par le serveur Netlify au lieu
// du navigateur, car la connexion directe navigateur → Firestore est bloquée pour
// certains utilisateurs (pare-feu/antivirus qui bloque son protocole spécial), alors que
// de simples requêtes HTTPS classiques (comme celle-ci) passent normalement.
//
// Le token de connexion (idToken) de l'utilisateur est transmis à Firestore via
// l'en-tête Authorization : les règles de sécurité Firestore s'appliquent donc
// exactement comme avant (aucun accès admin, aucun contournement des règles).

const PROJECT_ID = 'snowwishes-1cc53';
const BASE_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/';

async function fetchWithTimeout(url, options, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(function(){ controller.abort(); }, timeoutMs);
  try{
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  }catch(err){
    if(err.name === 'AbortError'){
      const e = new Error('Firestore n\'a pas répondu en moins de ' + (timeoutMs/1000) + 's (timeout).');
      e.code = 'timeout';
      throw e;
    }
    throw err;
  }finally{
    clearTimeout(timer);
  }
}

/* ---- Conversion JS <-> format typé Firestore (REST API) ---- */
function toFirestoreValue(v){
  if(v === null || v === undefined) return { nullValue: null };
  if(typeof v === 'string') return { stringValue: v };
  if(typeof v === 'boolean') return { booleanValue: v };
  if(typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if(Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if(typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}
function toFirestoreFields(obj){
  const fields = {};
  Object.keys(obj || {}).forEach(function(k){ fields[k] = toFirestoreValue(obj[k]); });
  return fields;
}
function fromFirestoreValue(v){
  if(!v) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return parseInt(v.integerValue, 10);
  if('doubleValue' in v) return v.doubleValue;
  if('booleanValue' in v) return v.booleanValue;
  if('nullValue' in v) return null;
  if('timestampValue' in v) return v.timestampValue;
  if('mapValue' in v) return fromFirestoreFields((v.mapValue && v.mapValue.fields) || {});
  if('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromFirestoreValue);
  return null;
}
function fromFirestoreFields(fields){
  const obj = {};
  Object.keys(fields || {}).forEach(function(k){ obj[k] = fromFirestoreValue(fields[k]); });
  return obj;
}

function decodeJwtPayload(token){
  try{
    const parts = token.split('.');
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  }catch(e){ return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { idToken, action, path, data } = JSON.parse(event.body || '{}');

    if (!idToken || !action || !path) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide (idToken, action ou path manquant).', code: 'app/invalid-request' }) };
    }

    const authHeaders = { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' };

    if (action === 'get') {
      let resp;
      try {
        resp = await fetchWithTimeout(BASE_URL + path, { method: 'GET', headers: authHeaders }, 8000);
      } catch (netErr) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre Firestore : ' + netErr.message, code: netErr.code === 'timeout' ? 'firestore/timeout' : 'firestore/network-error' }) };
      }
      if (resp.status === 404) {
        return { statusCode: 200, body: JSON.stringify({ exists: false, data: null }) };
      }
      const json = await resp.json();
      if (!resp.ok) {
        const code = resp.status === 403 ? 'permission-denied' : 'firestore/api-error';
        const tokenInfo = decodeJwtPayload(idToken);
        const diag = tokenInfo ? (' | Token: aud=' + tokenInfo.aud + ', provider=' + (tokenInfo.firebase && tokenInfo.firebase.sign_in_provider) + ', uid=' + tokenInfo.user_id) : ' | Token illisible';
        return { statusCode: resp.status, body: JSON.stringify({ error: 'Firestore a refusé la lecture : ' + JSON.stringify(json && json.error ? json.error : json) + diag, code: code }) };
      }
      return { statusCode: 200, body: JSON.stringify({ exists: true, data: fromFirestoreFields(json.fields) }) };
    }

    if (action === 'list') {
      let resp;
      try {
        resp = await fetchWithTimeout(BASE_URL + path, { method: 'GET', headers: authHeaders }, 8000);
      } catch (netErr) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre Firestore : ' + netErr.message, code: netErr.code === 'timeout' ? 'firestore/timeout' : 'firestore/network-error' }) };
      }
      const json = await resp.json();
      if (!resp.ok) {
        const detail = (json && json.error && json.error.message) ? json.error.message : ('status ' + resp.status);
        const code = resp.status === 403 ? 'permission-denied' : 'firestore/api-error';
        return { statusCode: resp.status, body: JSON.stringify({ error: 'Firestore a refusé la lecture : ' + detail, code: code }) };
      }
      const docs = (json.documents || []).map(function(d){
        const parts = (d.name || '').split('/');
        return Object.assign({ id: parts[parts.length - 1] }, fromFirestoreFields(d.fields));
      });
      return { statusCode: 200, body: JSON.stringify({ documents: docs }) };
    }

    if (action === 'delete') {
      let resp;
      try {
        resp = await fetchWithTimeout(BASE_URL + path, { method: 'DELETE', headers: authHeaders }, 8000);
      } catch (netErr) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre Firestore : ' + netErr.message, code: netErr.code === 'timeout' ? 'firestore/timeout' : 'firestore/network-error' }) };
      }
      if (!resp.ok && resp.status !== 404) {
        let json = {};
        try{ json = await resp.json(); }catch(e){}
        const detail = (json && json.error && json.error.message) ? json.error.message : ('status ' + resp.status);
        const code = resp.status === 403 ? 'permission-denied' : 'firestore/api-error';
        return { statusCode: resp.status, body: JSON.stringify({ error: 'Firestore a refusé la suppression : ' + detail, code: code }) };
      }
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (action === 'set' || action === 'update') {
      let url = BASE_URL + path;
      if (action === 'update') {
        const maskParams = Object.keys(data || {}).map(function(k){ return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
        url += '?' + maskParams;
      }
      let resp;
      try {
        resp = await fetchWithTimeout(url, {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ fields: toFirestoreFields(data) })
        }, 8000);
      } catch (netErr) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre Firestore : ' + netErr.message, code: netErr.code === 'timeout' ? 'firestore/timeout' : 'firestore/network-error' }) };
      }
      const json = await resp.json();
      if (!resp.ok) {
        const detail = (json && json.error && json.error.message) ? json.error.message : ('status ' + resp.status);
        const code = resp.status === 403 ? 'permission-denied' : 'firestore/api-error';
        return { statusCode: resp.status, body: JSON.stringify({ error: 'Firestore a refusé l\'écriture : ' + detail, code: code }) };
      }
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (action === 'add') {
      let resp;
      try {
        resp = await fetchWithTimeout(BASE_URL + path, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ fields: toFirestoreFields(data) })
        }, 8000);
      } catch (netErr) {
        return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre Firestore : ' + netErr.message, code: netErr.code === 'timeout' ? 'firestore/timeout' : 'firestore/network-error' }) };
      }
      const json = await resp.json();
      if (!resp.ok) {
        const detail = (json && json.error && json.error.message) ? json.error.message : ('status ' + resp.status);
        const code = resp.status === 403 ? 'permission-denied' : 'firestore/api-error';
        return { statusCode: resp.status, body: JSON.stringify({ error: 'Firestore a refusé la création : ' + detail, code: code }) };
      }
      const idParts = (json.name || '').split('/');
      const newId = idParts[idParts.length - 1];
      return { statusCode: 200, body: JSON.stringify({ success: true, id: newId }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Action inconnue : ' + action, code: 'app/unknown-action' }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur : ' + (err && err.message ? err.message : String(err)), code: 'app/server-error' }) };
  }
};
