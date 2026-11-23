import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingsService } from './recordings.service.js';
import { audioDuration } from './yandex-speech.service.js';
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://storage.example.invalid/private-recording') }));
vi.mock('./yandex-speech.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('./yandex-speech.service.js')>(), audioDuration: vi.fn(async () => 59.2),
}));
afterEach(() => vi.restoreAllMocks());

describe('Recording usage preflight', () => {
  it('returns private object size and rounded duration without starting recognition', async () => {
    const speech = { providerName: 'yandex', transcribe: vi.fn(), result: vi.fn() };
    const service = new RecordingsService(speech as never);
    const s3 = { send: vi.fn(async () => ({ ContentLength: 123456 })), destroy: vi.fn() };
    vi.spyOn(service, 'client').mockReturnValue(s3 as never);
    expect(await service.info('room-one', 'meetings/room-one/recording.mp4'))
      .toEqual({ sizeBytes: 123456, audioSeconds: 60, provider: 'yandex' });
    expect(speech.transcribe).not.toHaveBeenCalled(); expect(s3.destroy).toHaveBeenCalledOnce();
    expect(audioDuration).toHaveBeenCalledWith('https://storage.example.invalid/private-recording');
    await expect(service.info('room-one', 'meetings/room-two/recording.mp4')).rejects.toMatchObject({ status: 400 });
    expect(s3.send).toHaveBeenCalledOnce();
  });
  it('refuses a provider switch after reserving a budget and allows polling an already submitted task', async () => {
    const speech = { providerName: 'salute', start: vi.fn(), result: vi.fn(async () => ({ taskId: 'old-task', text: 'Ready' })) };
    const service = new RecordingsService(speech as never);
    await expect(service.transcribe('room', { key: 'meetings/room/a.mp4', expectedProvider: 'yandex', maxAudioSeconds: 60 }))
      .rejects.toMatchObject({ status: 403 });
    expect(speech.start).not.toHaveBeenCalled();
    expect(await service.transcribe('room', { key: 'meetings/room/a.mp4', taskId: 'old-task', expectedProvider: 'yandex' })).toHaveProperty('text', 'Ready');
    expect(speech.result).toHaveBeenCalledWith('old-task');
  });
});
