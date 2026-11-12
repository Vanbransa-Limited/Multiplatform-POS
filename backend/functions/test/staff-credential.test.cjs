const assert = require('node:assert/strict');
const test = require('node:test');
const { staffCredential } = require('../lib/modules/staff-admin/credential.js');

test('staff PIN provisioning and login agree, including leading zeroes', async () => {
  const client = await import('../../../frontend/src/services/staff-credential.js');
  for (const pin of ['0', '7', '12', '123', '0001', '1234']) {
    assert.equal(staffCredential(pin), `staff-pin-v1:${pin}`);
    assert.equal(client.staffCredential(pin), staffCredential(pin));
  }
  for (const password of ['existing-password', '12345678', ' secret123 ', '12345', 'abcd', '']) {
    assert.equal(staffCredential(password), password);
    assert.equal(client.staffCredential(password), password);
  }
});
