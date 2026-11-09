/* ================================================================
 * Código por correo al iniciar sesión — ayuda para la Lambda
 * `drex-username-resolve` (login con nombre de usuario).
 *
 * POR QUÉ EXISTE
 * El login con nombre de usuario NO pasa por el navegador de Cognito: la
 * Lambda autentica en el servidor con AdminInitiateAuth y devuelve solo los
 * tokens. Cuando el User Pool exige MFA por correo, Cognito contesta a esa
 * llamada con un DESAFÍO (EMAIL_OTP) en lugar de tokens. La Lambda debe:
 *   1) devolver al navegador {challenge:'mfa', mfaType:'email', destination,
 *      session} (el navegador ya sabe mostrar la pantalla del código), y
 *   2) en el paso 2 ({username, session, code, mfaType:'email'}) responder
 *      el desafío con AdminRespondToAuthChallenge y devolver los tokens.
 * Si la Lambda NO se actualiza, Cognito sigue protegiendo el login (no entrega
 * tokens sin el código): el login por usuario simplemente fallaría "cerrado".
 * Por eso hay que actualizar la Lambda ANTES de activar el MFA en el pool.
 *
 * ESTE ARCHIVO es lógica pura y sin dependencias (se le inyecta el cliente
 * de Cognito), con pruebas en test/email-mfa.test.js. Cópialo junto a
 * index.js de la Lambda y úsalo como se explica en README.md.
 * ================================================================ */
'use strict';

var EMAIL_PREFIX = 'EMAIL_OTP|';

function isEmailChallenge(name) { return name === 'EMAIL_OTP' || name === 'EMAIL_MFA'; }

function parseChoices(raw) {
  try {
    var v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(v)) return v.map(String);
  } catch (e) {
    if (typeof raw === 'string') return raw.replace(/[\[\]"\s]/g, '').split(',').filter(Boolean);
  }
  return [];
}

// Prioridad: app de autenticación (TOTP) > correo.
function pickMfaType(choices) {
  var i;
  for (i = 0; i < choices.length; i++) if (/SOFTWARE_TOKEN/i.test(choices[i])) return choices[i];
  for (i = 0; i < choices.length; i++) if (/EMAIL/i.test(choices[i])) return choices[i];
  return null;
}

// La sesión que se manda al navegador es opaca. Para el correo se le antepone
// el nombre del desafío ("EMAIL_OTP|<sesión>") para saber en el paso 2 a qué
// desafío contestar; el TOTP se queda igual que hoy (sin prefijo).
function encodeSession(challengeName, session) {
  return isEmailChallenge(challengeName) ? (challengeName + '|' + session) : session;
}
function decodeSession(raw) {
  var s = String(raw || '');
  var m = /^(EMAIL_OTP|EMAIL_MFA)\|(.+)$/.exec(s);
  if (m) return { challengeName: m[1], session: m[2], mfaType: 'email' };
  return { challengeName: 'SOFTWARE_TOKEN_MFA', session: s, mfaType: 'totp' };
}

/*
 * Interpreta la respuesta de AdminInitiateAuth / AdminRespondToAuthChallenge.
 * cognito: { adminRespondToAuthChallenge(params) -> Promise<resp> }
 * Devuelve:
 *   {type:'tokens', result}                 -> AuthenticationResult
 *   {type:'mfa', mfaType:'totp'|'email', session, destination}
 *   {type:'unsupported', challengeName}     -> responder 401 genérico
 */
async function classifyAuthResponse(cognito, ctx, resp) {
  if (resp && resp.AuthenticationResult) return { type: 'tokens', result: resp.AuthenticationResult };
  var name = resp && resp.ChallengeName;
  if (name === 'SELECT_MFA_TYPE') {
    var pick = pickMfaType(parseChoices(resp.ChallengeParameters && resp.ChallengeParameters.MFAS_CAN_CHOOSE));
    if (!pick) return { type: 'unsupported', challengeName: name };
    var next = await cognito.adminRespondToAuthChallenge({
      UserPoolId: ctx.userPoolId,
      ClientId: ctx.clientId,
      ChallengeName: 'SELECT_MFA_TYPE',
      ChallengeResponses: { USERNAME: ctx.cognitoUsername, ANSWER: pick },
      Session: resp.Session
    });
    return classifyAuthResponse(cognito, ctx, next);
  }
  if (name === 'SOFTWARE_TOKEN_MFA') {
    return { type: 'mfa', mfaType: 'totp', session: encodeSession(name, resp.Session), destination: '' };
  }
  if (isEmailChallenge(name)) {
    var p = resp.ChallengeParameters || {};
    return {
      type: 'mfa', mfaType: 'email',
      session: encodeSession(name, resp.Session),
      destination: p.CODE_DELIVERY_DESTINATION || ''
    };
  }
  return { type: 'unsupported', challengeName: name || '' };
}

// Cuerpo JSON del paso 1 para el navegador cuando hay desafío.
function challengeBody(c) {
  var body = { challenge: 'mfa', session: c.session };
  if (c.mfaType === 'email') { body.mfaType = 'email'; body.destination = c.destination || ''; }
  return body;
}

// Paso 2: parámetros para AdminRespondToAuthChallenge con el código.
// Devuelve null si el código no tiene el formato esperado (6 dígitos).
function buildRespondParams(ctx, session, code) {
  var c = String(code == null ? '' : code).trim();
  if (!/^\d{6}$/.test(c)) return null;
  var d = decodeSession(session);
  var responses = { USERNAME: ctx.cognitoUsername };
  if (d.mfaType === 'email') {
    responses.EMAIL_OTP_CODE = c;
    responses.EMAIL_MFA_CODE = c;
  } else {
    responses.SOFTWARE_TOKEN_MFA_CODE = c;
  }
  return {
    UserPoolId: ctx.userPoolId,
    ClientId: ctx.clientId,
    ChallengeName: d.challengeName,
    ChallengeResponses: responses,
    Session: d.session
  };
}

module.exports = {
  isEmailChallenge: isEmailChallenge,
  parseChoices: parseChoices,
  pickMfaType: pickMfaType,
  encodeSession: encodeSession,
  decodeSession: decodeSession,
  classifyAuthResponse: classifyAuthResponse,
  challengeBody: challengeBody,
  buildRespondParams: buildRespondParams,
  EMAIL_PREFIX: EMAIL_PREFIX
};
