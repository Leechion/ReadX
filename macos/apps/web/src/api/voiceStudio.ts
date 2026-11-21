import { authenticatedFetch, request } from './client';

export interface StudioVoice {
  id: string;
  name: string;
  language?: string;
  kind: 'default' | 'profile' | 'design' | 'preset';
  model?: string;
  engine?: string;
  featured?: boolean;
}

export interface StudioCatalog {
  voices: StudioVoice[];
  cloneModel: string;
}

export function loadVoiceStudio(signal: AbortSignal): Promise<StudioCatalog> {
  return request('/v1/voice-studio/voices', { signal });
}

export async function synthesizeSpeech(voice: StudioVoice, text: string, rate: number, signal: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch('/v1/voice-studio/speech', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, kind: voice.kind, voice: voice.id, model: voice.model, rate }),
  });
  return response.blob();
}

export async function saveOwnVoice(name: string, transcript: string, audio: Blob, signal: AbortSignal): Promise<StudioVoice> {
  const form = new FormData();
  form.set('name', name);
  form.set('ref_text', transcript);
  form.set('ref_audio', audio);
  form.set('own_voice', 'yes');
  const response = await authenticatedFetch('/v1/voice-studio/recordings', { method: 'POST', body: form, signal });
  return response.json() as Promise<StudioVoice>;
}
