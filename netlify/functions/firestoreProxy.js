// Le token de connexion (idToken) de l'utilisateur est transmis à Firestore via
// l'en-tête Authorization : les règles de sécurité Firestore s'appliquent donc
// exactement comme avant (aucun accès admin, aucun contournement des règles).
 
const PROJECT_ID = 'noujoum-1cc53';

const PROJECT_ID = 'snowwishes-1cc53';
const BASE_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/';
 

async function fetchWithTimeout(url, options, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(function(){ controller.abort(); }, timeoutMs);
@@ -27,7 +27,7 @@ async function fetchWithTimeout(url, options, timeoutMs){
    clearTimeout(timer);
  }
}
 

/* ---- Conversion JS <-> format typé Firestore (REST API) ---- */
function toFirestoreValue(v){
  if(v === null || v === undefined) return { nullValue: null };
@@ -60,29 +60,29 @@ function fromFirestoreFields(fields){
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
@@ -102,7 +102,7 @@ exports.handler = async (event) => {
      }
      return { statusCode: 200, body: JSON.stringify({ exists: true, data: fromFirestoreFields(json.fields) }) };
    }
 

    if (action === 'list') {
      let resp;
      try {
@@ -122,7 +122,7 @@ exports.handler = async (event) => {
      });
      return { statusCode: 200, body: JSON.stringify({ documents: docs }) };
    }
 

    if (action === 'set' || action === 'update') {
      let url = BASE_URL + path;
      if (action === 'update') {
@@ -147,7 +147,7 @@ exports.handler = async (event) => {
      }
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }
 

    if (action === 'add') {
      let resp;
      try {
@@ -169,12 +169,11 @@ exports.handler = async (event) => {
      const newId = idParts[idParts.length - 1];
      return { statusCode: 200, body: JSON.stringify({ success: true, id: newId }) };
    }
 

    return { statusCode: 400, body: JSON.stringify({ error: 'Action inconnue : ' + action, code: 'app/unknown-action' }) };
 

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur : ' + (err && err.message ? err.message : String(err)), code: 'app/server-error' }) };
  }
};
