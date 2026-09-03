import { createMultipartUploader, upload } from '@vercel/blob/client';

const STUDIO_URL = 'https://studio.limova.ai';

globalThis.LimovaTrainingRecordingUpload = async function uploadTrainingRecording({
  blob,
  token,
  sessionId,
  durationMs,
  onProgress
}) {
  const extension = blob.type === 'video/mp4' ? 'mp4' : 'webm';
  const pathname = `training-recordings/${sessionId}/${crypto.randomUUID()}.${extension}`;
  let result;
  try {
    result = await upload(pathname, blob, {
      access: 'private',
      contentType: blob.type || 'video/webm',
      handleUploadUrl: `${STUDIO_URL}/api/training/sessions/recording-upload`,
      clientPayload: JSON.stringify({ token, sessionId, durationMs }),
      multipart: blob.size >= 8 * 1024 * 1024,
      onUploadProgress: progress => onProgress?.(progress)
    });
  } catch (cause) {
    const error = new Error('L’envoi vidéo a échoué. Vérifie ta connexion puis clique sur « Réessayer l’envoi » sans fermer le panneau.');
    error.code = 'TRAINING_BLOB_UPLOAD_FAILED';
    error.stage = 'blob_upload';
    error.cause = cause;
    throw error;
  }
  const confirmation = await fetch(`${STUDIO_URL}/api/training/sessions/recording-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, pathname: result.pathname, durationMs })
  });
  if (!confirmation.ok) {
    const error = new Error('La vidéo a été envoyée, mais le Studio n’a pas pu la vérifier. Clique sur « Réessayer l’envoi ».');
    error.code = 'TRAINING_RECORDING_CONFIRMATION_FAILED';
    error.stage = 'studio_confirmation';
    error.status = confirmation.status;
    throw error;
  }
  return result;
};

globalThis.LimovaTrainingMultipartUpload = async function createTrainingMultipartUpload({ token, sessionId, contentType = 'video/webm' }) {
  const extension = contentType === 'video/mp4' ? 'mp4' : 'webm';
  const pathname = `training-recordings/${sessionId}/${crypto.randomUUID()}.${extension}`;
  const tokenResponse = await fetch(`${STUDIO_URL}/api/training/sessions/recording-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, pathname, contentType })
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.clientToken) throw Object.assign(new Error('La synchronisation vidéo n’a pas pu démarrer.'), { code: 'TRAINING_MULTIPART_TOKEN_FAILED' });
  const uploader = await createMultipartUploader(pathname, { access: 'private', token: tokenData.clientToken, contentType });
  const parts = [];
  return {
    pathname,
    async uploadPart(partNumber, blob) {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const part = await uploader.uploadPart(partNumber, blob);
          parts.push(part);
          return part;
        } catch (error) {
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
        }
      }
      throw Object.assign(new Error('Une partie de la vidéo n’a pas pu être synchronisée. Gardez le panneau ouvert et réessayez.'), { code: 'TRAINING_MULTIPART_PART_FAILED', cause: lastError });
    },
    async complete({ durationMs }) {
      const result = await uploader.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
      const confirmation = await fetch(`${STUDIO_URL}/api/training/sessions/recording-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, pathname: result.pathname, durationMs })
      });
      if (!confirmation.ok) throw Object.assign(new Error('La vidéo est envoyée mais sa vérification a échoué. Réessayez sans fermer le panneau.'), { code: 'TRAINING_RECORDING_CONFIRMATION_FAILED' });
      return result;
    }
  };
};
