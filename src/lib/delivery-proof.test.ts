import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveredEvent, deliveryCaption } from './delivery-proof.js';
import { dxTrackingEvents } from './dx-freight.js';

const event = (over: Partial<ReturnType<typeof dxTrackingEvents>[number]>) => ({ at: null, status: '', podName: null, podAt: null, signatureRef: null, photoRefs: [], gps: null, ...over });

test('DX events are read with their proof of delivery', () => {
  const [row] = dxTrackingEvents({
    Status: 0,
    TrackingEvents: [{
      TrackingEventDateTime: '/Date(1795600745000+0000)/',
      EventStatusCode: 'F00',
      PODName: 'porch',
      PODDateTime: '2026-11-18T09:59:05',
      PODImageAttachmentRef: 'SIG1',
      DeliveryPhotoAttachmentRefs: ['PH1', ''],
      DeliveryGPSCoOrds: { Latitude: 51.27, Longitude: 0.52 },
    }],
  });
  assert.equal(row.podName, 'porch');
  assert.equal(row.signatureRef, 'SIG1');
  assert.deepEqual(row.photoRefs, ['PH1']);
  assert.deepEqual(row.gps, { lat: 51.27, lng: 0.52 });
  assert.ok(row.at?.startsWith('2026-'));
});

test('a zero GPS reading is no reading', () => {
  const [row] = dxTrackingEvents({ TrackingEvents: [{ DeliveryGPSCoOrds: { Latitude: 0, Longitude: 0 } }] });
  assert.equal(row.gps, null);
});

test('the delivered event is the one with proof', () => {
  const picked = deliveredEvent([
    event({ at: '2026-11-17T05:00:00Z', status: 'A' }),
    event({ at: '2026-11-18T09:59:00Z', podName: 'porch', photoRefs: ['PH1'] }),
  ]);
  assert.equal(picked?.podName, 'porch');
  assert.equal(deliveredEvent([event({ at: '2026-11-17T05:00:00Z' })]), null);
});

test('the caption says courier, what, when and who signed', () => {
  const text = deliveryCaption('DX', { podAt: '2026-11-18T09:59:05Z', at: null, podName: 'porch' }, 'photo');
  assert.match(text, /^DX delivery photo, 18 Nov/);
  assert.match(text, /signed porch$/);
});
