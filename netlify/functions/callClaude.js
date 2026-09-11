// netlify/functions/callClaude.js
// (le nom du fichier reste "callClaude" pour ne rien casser côté site — mais elle appelle
// maintenant l'API Gemini de Google, gratuite, à la place de l'API Anthropic.)
//
// Aucune dépendance externe nécessaire (utilise fetch, intégré à Node.js 18+).
 
/* Ajoute une limite de temps explicite à un fetch : si Google ne répond pas assez vite,
   on obtient une erreur claire ("timeout après Xs") au lieu d'un 504 opaque renvoyé par
   Netlify quand toute la fonction dépasse sa limite d'exécution globale. */
async function fetchWithTimeout(url, options, timeoutMs, label){
  const controller = new AbortController();
  const timer = setTimeout(function(){ controller.abort(); }, timeoutMs);
  try{
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  }catch(err){
    if(err.name === 'AbortError'){
      const e = new Error(label + ' n\'a pas répondu en moins de ' + (timeoutMs/1000) + 's (timeout).');
      e.code = 'timeout';
      throw e;
    }
    throw err;
  }finally{
    clearTimeout(timer);
  }
}
 
function convertMessagesToGemini(messages){
  return messages.map(function(msg){
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let parts;
    if(typeof msg.content === 'string'){
      parts = [{ text: msg.content }];
    } else if(Array.isArray(msg.content)){
      parts = msg.content.map(function(block){
        if(block.type === 'text'){ return { text: block.text }; }
        if(block.type === 'image'){
          return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
        }
        return { text: '' };
      });
    } else {
      parts = [{ text: '' }];
    }
    return { role: role, parts: parts };
  });
}
 
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
 
  try {
    // 0) Vérifie d'abord que les variables d'environnement nécessaires existent bien.
    //    Sans ça, l'erreur qui remonte plus loin (ex: "clé invalide") cache la vraie cause.
    if (!process.env.FIREBASE_WEB_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Variable d'environnement FIREBASE_WEB_API_KEY manquante sur Netlify.", code: 'env/missing-firebase-key' }) };
    }
    if (!process.env.GEMINI_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Variable d'environnement GEMINI_API_KEY manquante sur Netlify.", code: 'env/missing-gemini-key' }) };
    }
 
    const { idToken, system, messages } = JSON.parse(event.body || '{}');
 
    if (!idToken || !messages) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide (idToken ou messages manquant).', code: 'app/invalid-request' }) };
    }
 
    // 1) Vérifie que l'étudiant est bien connecté, via l'API publique de Firebase Auth
    let verifyResp, verifyData;
    try {
      verifyResp = await fetchWithTimeout(
        'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_WEB_API_KEY,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: idToken })
        },
        6000, 'Firebase Auth'
      );
      verifyData = await verifyResp.json();
    } catch (netErr) {
      const code = netErr.code === 'timeout' ? 'auth/verify-timeout' : 'auth/verify-network-error';
      return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre Firebase Auth pour vérifier la session : ' + netErr.message, code: code }) };
    }
    if (!verifyResp.ok || !verifyData.users || verifyData.users.length === 0) {
      const detail = (verifyData && verifyData.error && verifyData.error.message) ? verifyData.error.message : 'session invalide';
      return { statusCode: 401, body: JSON.stringify({ error: 'Session invalide, reconnecte-toi (' + detail + ').', code: 'auth/session-invalid' }) };
    }
 
    // 2) Appel réel à l'API Gemini (gratuite) — la clé reste ici, jamais visible côté navigateur
    /* "gemini-flash-latest" pointe vers un modèle EXPÉRIMENTAL avec des limites de
       débit très restrictives (donc les erreurs "haute demande" et les timeouts
       fréquents) — on utilise à la place un modèle stable, rapide et peu coûteux. */
    const geminiModel = 'gemini-3.5-flash-lite';
    const geminiBody = {
      contents: convertMessagesToGemini(messages),
      generationConfig: { maxOutputTokens: 1000 }
    };
    if (system) {
      geminiBody.systemInstruction = { parts: [{ text: system }] };
    }
 
    let response, data;
    try {
      response = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/' + geminiModel + ':generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY
          },
          body: JSON.stringify(geminiBody)
        },
        20000, 'Gemini'
      );
      data = await response.json();
    } catch (netErr) {
      console.error('Impossible de joindre Gemini:', netErr);
      const code = netErr.code === 'timeout' ? 'gemini/timeout' : 'gemini/network-error';
      return { statusCode: 502, body: JSON.stringify({ error: 'Impossible de joindre l\'API Gemini : ' + netErr.message, code: code }) };
    }
 
    if (!response.ok) {
      console.error('Erreur API Gemini:', data);
      const detail = (data && data.error && data.error.message) ? data.error.message : ('status ' + response.status);
      return { statusCode: 500, body: JSON.stringify({ error: "Erreur lors de l'appel à l'IA : " + detail, code: 'gemini/api-error' }) };
    }
 
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(function(p){ return p.text || ''; }).join('\n')
      : '';
    const finishReason = candidate ? candidate.finishReason : 'STOP';
    const stopReason = finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
 
    return {
      statusCode: 200,
      body: JSON.stringify({ text: text, stopReason: stopReason })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur : ' + (err && err.message ? err.message : String(err)), code: 'app/server-error' }) };
  }
};
 
