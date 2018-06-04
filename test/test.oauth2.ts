/**
 * Copyright 2013 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'assert';
import {AxiosError} from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import nock from 'nock';
import path from 'path';
import qs from 'querystring';
import url from 'url';

import {CodeChallengeMethod, GoogleAuth, OAuth2Client} from '../src';
import {LoginTicket} from '../src/auth/loginticket';
import {CertificateDictionary, CertificateFormat} from '../src/auth/oauth2client';

nock.disableNetConnect();

const CLIENT_ID = 'CLIENT_ID';
const CLIENT_SECRET = 'CLIENT_SECRET';
const REDIRECT_URI = 'REDIRECT';
const ACCESS_TYPE = 'offline';
const SCOPE = 'scopex';
const SCOPE_ARRAY = ['scopex', 'scopey'];
const publicKey = fs.readFileSync('./test/fixtures/public.pem', 'utf-8');
const privateKey = fs.readFileSync('./test/fixtures/private.pem', 'utf-8');
const baseUrl = 'https://www.googleapis.com';
const certsPathPem = '/oauth2/v1/certs';
const certsPathJwk = '/oauth2/v3/certs';
const certsResPathPem =
    path.join(__dirname, '../../test/fixtures/oauthcertspem.json');
const certsResPathJwk =
    path.join(__dirname, '../../test/fixtures/oauthcertsjwk.json');

let client: OAuth2Client;
beforeEach(() => {
  client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
});

afterEach(() => {
  nock.cleanAll();
});

it('should generate a valid consent page url', done => {
  const opts = {
    access_type: ACCESS_TYPE,
    scope: SCOPE,
    response_type: 'code token'
  };

  const oauth2client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI
  });

  const generated = oauth2client.generateAuthUrl(opts);
  const parsed = url.parse(generated);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const query = qs.parse(parsed.query);
  assert.equal(query.response_type, 'code token');
  assert.equal(query.access_type, ACCESS_TYPE);
  assert.equal(query.scope, SCOPE);
  assert.equal(query.client_id, CLIENT_ID);
  assert.equal(query.redirect_uri, REDIRECT_URI);
  done();
});

it('should throw an error if generateAuthUrl is called with invalid parameters',
   () => {
     const opts = {
       access_type: ACCESS_TYPE,
       scope: SCOPE,
       code_challenge_method: CodeChallengeMethod.S256
     };
     try {
       const generated = client.generateAuthUrl(opts);
       assert.fail('Expected to throw');
     } catch (e) {
       assert.equal(
           e.message,
           'If a code_challenge_method is provided, code_challenge must be included.');
     }
   });

it('should generate a valid code verifier and resulting challenge',
   async () => {
     const codes = await client.generateCodeVerifier();
     // ensure the code_verifier matches all requirements
     assert.equal(codes.codeVerifier.length, 128);
     const match = codes.codeVerifier.match(/[a-zA-Z0-9\-\.~_]*/);
     assert(match);
     if (!match) return;
     assert(match.length > 0 && match[0] === codes.codeVerifier);
   });

it('should include code challenge and method in the url', async () => {
  const codes = await client.generateCodeVerifier();
  const authUrl = client.generateAuthUrl({
    code_challenge: codes.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256
  });
  const parsed = url.parse(authUrl);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const props = qs.parse(parsed.query);
  assert.equal(props.code_challenge, codes.codeChallenge);
  assert.equal(props.code_challenge_method, CodeChallengeMethod.S256);
});

it('should verifyIdToken properly', async () => {
  const fakeCerts = {a: 'a', b: 'b'};
  const idToken = 'idToken';
  const audience = 'fakeAudience';
  const maxExpiry = 5;
  const payload =
      {aud: 'aud', sub: 'sub', iss: 'iss', iat: 1514162443, exp: 1514166043};
  const scope = nock(baseUrl).get('/oauth2/v1/certs').reply(200, fakeCerts);
  client.verifySignedJwtWithCerts =
      (jwt: string, certs: CertificateDictionary, format: CertificateFormat,
       requiredAudience: string|string[], issuers?: string[],
       theMaxExpiry?: number) => {
        assert.equal(jwt, idToken);
        assert.equal(JSON.stringify(certs), JSON.stringify(fakeCerts));
        assert.equal(requiredAudience, audience);
        assert.equal(theMaxExpiry, maxExpiry);
        return Promise.resolve(new LoginTicket('c', payload));
      };
  const result = await client.verifyIdToken({idToken, audience, maxExpiry});
  scope.done();
  assert.notEqual(result, null);
  if (result) {
    assert.equal(result.getEnvelope(), 'c');
    assert.equal(result.getPayload(), payload);
  }
});

it('should provide a reasonable error in verifyIdToken with wrong parameters',
   async () => {
     const fakeCerts = {a: 'a', b: 'b'};
     const idToken = 'idToken';
     const audience = 'fakeAudience';
     const payload =
         {aud: 'aud', sub: 'sub', iss: 'iss', iat: 1514162443, exp: 1514166043};
     client.verifySignedJwtWithCerts =
         (jwt: string, certs: CertificateDictionary, format: CertificateFormat,
          requiredAudience: string|string[], issuers?: string[],
          theMaxExpiry?: number) => {
           assert.equal(jwt, idToken);
           assert.equal(JSON.stringify(certs), JSON.stringify(fakeCerts));
           assert.equal(requiredAudience, audience);
           return Promise.resolve(new LoginTicket('c', payload));
         };
     try {
       // tslint:disable-next-line no-any
       await (client as any).verifyIdToken(idToken, audience);
       throw new Error('Expected to throw');
     } catch (e) {
       assert.equal(
           e.message,
           'This method accepts an options object as the first parameter, which includes the idToken, audience, and maxExpiry.');
     }
   });

it('should allow scopes to be specified as array', () => {
  const opts = {
    access_type: ACCESS_TYPE,
    scope: SCOPE_ARRAY,
    response_type: 'code token'
  };
  const generated = client.generateAuthUrl(opts);
  const parsed = url.parse(generated);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const query = qs.parse(parsed.query);
  assert.equal(query.scope, SCOPE_ARRAY.join(' '));
});

it('should set response_type param to code if none is given while generating the consent page url',
   () => {
     const generated = client.generateAuthUrl();
     const parsed = url.parse(generated);
     if (typeof parsed.query !== 'string') {
       throw new Error('Unable to parse querystring');
     }
     const query = qs.parse(parsed.query);
     assert.equal(query.response_type, 'code');
   });

it('should verify a valid certificate against a jwt', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = JSON.stringify({kid: 'keyid', alg: 'RS256'});
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  const login = await client.verifySignedJwtWithCerts(
      data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
  assert.equal(login.getUserId(), '123456789');
});

it('should fail due to invalid audience', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"wrongaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';

  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Wrong recipient/));
  }
});

it('should fail due to invalid array of audiences', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"wrongaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';

  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  const validAudiences = ['testaudience', 'extra-audience'];
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, validAudiences);
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Wrong recipient/));
  }
});

it('should fail due to invalid signature', async () => {
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":1393241597,' +
      '"exp":1393245497' +
      '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  // Originally: data += '.'+signature;
  data += signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Wrong number of segments/));
  }
});

it('should fail due to invalid envelope', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid"' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Can\'t parse token envelope/));
  }
});

it('should fail due to invalid payload', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer"' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Can\'t parse token payload/));
  }
});

it('should fail due to invalid signature', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  const data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64') + '.' +
      'broken-signature';
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Invalid token signature/));
  }
});

it('should fail due to no expiration date', async () => {
  const now = new Date().getTime() / 1000;
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/No expiration time/));
  }
});

it('should fail due to no issue time', async () => {
  const maxLifetimeSecs = 86400;
  const now = new Date().getTime() / 1000;
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/No issue time/));
  }
});

it('should fail due to certificate with expiration date in future',
   async () => {
     const maxLifetimeSecs = 86400;
     const now = new Date().getTime() / 1000;
     const expiry = now + (2 * maxLifetimeSecs);
     const idToken = '{' +
         '"iss":"testissuer",' +
         '"aud":"testaudience",' +
         '"azp":"testauthorisedparty",' +
         '"email_verified":"true",' +
         '"id":"123456789",' +
         '"sub":"123456789",' +
         '"email":"test@test.com",' +
         '"iat":' + now + ',' +
         '"exp":' + expiry + '}';
     const envelope = '{' +
         '"kid":"keyid",' +
         '"alg":"RS256"' +
         '}';
     let data = new Buffer(envelope).toString('base64') + '.' +
         new Buffer(idToken).toString('base64');
     const signer = crypto.createSign('sha256');
     signer.update(data);
     const signature = signer.sign(privateKey, 'base64');
     data += '.' + signature;
     try {
       await client.verifySignedJwtWithCerts(
           data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
       assert(false);
     } catch (err) {
       assert(err.toString().match(/Expiration time too far in future/));
     }
   });

it('should pass due to expiration date in future with adjusted max expiry',
   async () => {
     const maxLifetimeSecs = 86400;
     const now = new Date().getTime() / 1000;
     const expiry = now + (2 * maxLifetimeSecs);
     const maxExpiry = (3 * maxLifetimeSecs);
     const idToken = '{' +
         '"iss":"testissuer",' +
         '"aud":"testaudience",' +
         '"azp":"testauthorisedparty",' +
         '"email_verified":"true",' +
         '"id":"123456789",' +
         '"sub":"123456789",' +
         '"email":"test@test.com",' +
         '"iat":' + now + ',' +
         '"exp":' + expiry + '}';
     const envelope = '{' +
         '"kid":"keyid",' +
         '"alg":"RS256"' +
         '}';
     let data = new Buffer(envelope).toString('base64') + '.' +
         new Buffer(idToken).toString('base64');
     const signer = crypto.createSign('sha256');
     signer.update(data);
     const signature = signer.sign(privateKey, 'base64');
     data += '.' + signature;
     client.verifySignedJwtWithCerts(
         data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience',
         ['testissuer'], maxExpiry);
   });

it('should fail due to token being used to early', async () => {
  const maxLifetimeSecs = 86400;
  const clockSkews = 300;
  const now = (new Date().getTime() / 1000);
  const expiry = now + (maxLifetimeSecs / 2);
  const issueTime = now + (clockSkews * 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + issueTime + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Token used too early/));
  }
});

it('should fail due to token being used to late', async () => {
  const maxLifetimeSecs = 86400;
  const clockSkews = 300;
  const now = (new Date().getTime() / 1000);
  const expiry = now - (maxLifetimeSecs / 2);
  const issueTime = now - (clockSkews * 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + issueTime + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';

  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience');
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Token used too late/));
  }
});

it('should fail due to invalid issuer', async () => {
  const maxLifetimeSecs = 86400;
  const now = (new Date().getTime() / 1000);
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"invalidissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  try {
    await client.verifySignedJwtWithCerts(
        data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience',
        ['testissuer']);
    assert(false);
  } catch (err) {
    assert(err.toString().match(/Invalid issuer/));
  }
});

it('should pass due to valid issuer', async () => {
  const maxLifetimeSecs = 86400;
  const now = (new Date().getTime() / 1000);
  const expiry = now + (maxLifetimeSecs / 2);
  const idToken = '{' +
      '"iss":"testissuer",' +
      '"aud":"testaudience",' +
      '"azp":"testauthorisedparty",' +
      '"email_verified":"true",' +
      '"id":"123456789",' +
      '"sub":"123456789",' +
      '"email":"test@test.com",' +
      '"iat":' + now + ',' +
      '"exp":' + expiry + '}';
  const envelope = '{' +
      '"kid":"keyid",' +
      '"alg":"RS256"' +
      '}';
  let data = new Buffer(envelope).toString('base64') + '.' +
      new Buffer(idToken).toString('base64');
  const signer = crypto.createSign('sha256');
  signer.update(data);
  const signature = signer.sign(privateKey, 'base64');
  data += '.' + signature;
  client.verifySignedJwtWithCerts(
      data, {keyid: publicKey}, CertificateFormat.PEM, 'testaudience',
      ['testissuer']);
});

it('should be able to retrieve a list of Google PEM certificates', (done) => {
  const scope =
      nock(baseUrl).get(certsPathPem).replyWithFile(200, certsResPathPem);
  client.getFederatedSignonCerts(CertificateFormat.PEM, (err, certs) => {
    assert.equal(err, null);
    assert.equal(Object.keys(certs).length, 2);
    assert.notEqual(certs.a15eea964ab9cce480e5ef4f47cb17b9fa7d0b21, null);
    assert.notEqual(certs['39596dc3a3f12aa74b481579e4ec944f86d24b95'], null);
    scope.done();
    done();
  });
});

it('should be able to retrieve a list of Google PEM certificates from cache again',
   done => {
     const scope =
         nock(baseUrl)
             .defaultReplyHeaders({
               'Cache-Control':
                   'public, max-age=23641, must-revalidate, no-transform',
               'Content-Type': 'application/json'
             })
             .get(certsPathPem)
             .replyWithFile(200, certsResPathPem);
     client.getFederatedSignonCerts(CertificateFormat.PEM, (err, certs) => {
       assert.equal(err, null);
       assert.equal(Object.keys(certs).length, 2);
       scope.done();  // has retrieved from nock... nock no longer will reply
       client.getFederatedSignonCerts(CertificateFormat.PEM, (err2, certs2) => {
         assert.equal(err2, null);
         assert.equal(Object.keys(certs2).length, 2);
         scope.done();
         done();
       });
     });
   });

it('should be able to retrieve a list of Google JWK certificates', (done) => {
  const scope =
      nock(baseUrl).get(certsPathJwk).replyWithFile(200, certsResPathJwk);
  client.getFederatedSignonCerts(CertificateFormat.JWK, (err, certs) => {
    assert.equal(err, null);
    assert.equal(Object.keys(certs).length, 2);
    assert.notEqual(certs['029f269f3f06af1e93dac67063977f713a77f19e'], null);
    assert.notEqual(certs['3bcf0b3cc862a0ac77092f72b4dfdb20a8100df0'], null);
    scope.done();
    done();
  });
});

it('should be able to retrieve a list of Google JWK certificates from cache again',
   done => {
     const scope =
         nock(baseUrl)
             .defaultReplyHeaders({
               'Cache-Control':
                   'public, max-age=23641, must-revalidate, no-transform',
               'Content-Type': 'application/json'
             })
             .get(certsPathJwk)
             .replyWithFile(200, certsResPathJwk);
     client.getFederatedSignonCerts(CertificateFormat.JWK, (err, certs) => {
       assert.equal(err, null);
       assert.equal(Object.keys(certs).length, 2);
       scope.done();  // has retrieved from nock... nock no longer will reply
       client.getFederatedSignonCerts(CertificateFormat.JWK, (err2, certs2) => {
         assert.equal(err2, null);
         assert.equal(Object.keys(certs2).length, 2);
         scope.done();
         done();
       });
     });
   });

it('should set redirect_uri if not provided in options', () => {
  const generated = client.generateAuthUrl({});
  const parsed = url.parse(generated);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const query = qs.parse(parsed.query);
  assert.equal(query.redirect_uri, REDIRECT_URI);
});

it('should set client_id if not provided in options', () => {
  const generated = client.generateAuthUrl({});
  const parsed = url.parse(generated);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const query = qs.parse(parsed.query);
  assert.equal(query.client_id, CLIENT_ID);
});

it('should override redirect_uri if provided in options', () => {
  const generated = client.generateAuthUrl({redirect_uri: 'overridden'});
  const parsed = url.parse(generated);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const query = qs.parse(parsed.query);
  assert.equal(query.redirect_uri, 'overridden');
});

it('should override client_id if provided in options', () => {
  const generated = client.generateAuthUrl({client_id: 'client_override'});
  const parsed = url.parse(generated);
  if (typeof parsed.query !== 'string') {
    throw new Error('Unable to parse querystring');
  }
  const query = qs.parse(parsed.query);
  assert.equal(query.client_id, 'client_override');
});

it('should return error in callback on request', done => {
  client.request({}, (err, result) => {
    assert.equal(err!.message, 'No access, refresh token or API key is set.');
    assert.equal(result, null);
    done();
  });
});

it('should return error in callback on refreshAccessToken', done => {
  client.refreshAccessToken((err, result) => {
    assert.equal(err!.message, 'No refresh token is set.');
    assert.equal(result, null);
    done();
  });
});


function mockExample() {
  return [
    nock(baseUrl)
        .post(
            '/oauth2/v4/token', undefined,
            {reqheaders: {'content-type': 'application/x-www-form-urlencoded'}})
        .reply(200, {access_token: 'abc123', expires_in: 1}),
    nock('http://example.com').get('/').reply(200)
  ];
}

it('should refresh token if missing access token', (done) => {
  const scopes = mockExample();
  const accessToken = 'abc123';
  let raisedEvent = false;
  const refreshToken = 'refresh-token-placeholder';
  client.credentials = {refresh_token: refreshToken};

  // ensure the tokens event is raised
  client.on('tokens', tokens => {
    assert.equal(tokens.access_token, accessToken);
    raisedEvent = true;
  });

  client.request({url: 'http://example.com'}, err => {
    scopes.forEach(s => s.done());
    assert(raisedEvent);
    assert.equal(accessToken, client.credentials.access_token);
    done();
  });
});

it('should unify the promise when refreshing the token', async () => {
  // Mock a single call to the token server, and 3 calls to the example
  // endpoint. This makes sure that refreshToken is called only once.
  const scopes = [
    nock(baseUrl)
        .post(
            '/oauth2/v4/token', undefined,
            {reqheaders: {'content-type': 'application/x-www-form-urlencoded'}})
        .reply(200, {access_token: 'abc123', expires_in: 1}),
    nock('http://example.com').get('/').thrice().reply(200)
  ];
  client.credentials = {refresh_token: 'refresh-token-placeholder'};
  await Promise.all([
    client.request({url: 'http://example.com'}),
    client.request({url: 'http://example.com'}),
    client.request({url: 'http://example.com'})
  ]);
  scopes.forEach(s => s.done());
  assert.equal('abc123', client.credentials.access_token);
});

it('should clear the cached refresh token promise after completion',
   async () => {
     // Mock 2 calls to the token server and 2 calls to the example endpoint.
     // This makes sure that the token endpoint is invoked twice, preventing the
     // promise from getting cached for too long.
     const scopes = [
       nock(baseUrl)
           .post('/oauth2/v4/token', undefined, {
             reqheaders: {'content-type': 'application/x-www-form-urlencoded'}
           })
           .twice()
           .reply(200, {access_token: 'abc123', expires_in: 100000}),
       nock('http://example.com').get('/').twice().reply(200)
     ];
     client.credentials = {refresh_token: 'refresh-token-placeholder'};
     await client.request({url: 'http://example.com'});
     client.credentials.access_token = null;
     await client.request({url: 'http://example.com'});
     scopes.forEach(s => s.done());
     assert.equal('abc123', client.credentials.access_token);
   });

it('should clear the cached refresh token promise after throw', async () => {
  // Mock a failed call to the refreshToken endpoint. This should trigger
  // a second call to refreshToken, which should use a different promise.
  const scopes = [
    nock(baseUrl)
        .post(
            '/oauth2/v4/token', undefined,
            {reqheaders: {'content-type': 'application/x-www-form-urlencoded'}})
        .reply(500)
        .post(
            '/oauth2/v4/token', undefined,
            {reqheaders: {'content-type': 'application/x-www-form-urlencoded'}})
        .reply(200, {access_token: 'abc123', expires_in: 100000}),
    nock('http://example.com').get('/').reply(200)
  ];
  client.credentials = {refresh_token: 'refresh-token-placeholder'};
  try {
    await client.request({url: 'http://example.com'});
  } catch (e) {
  }
  await client.request({url: 'http://example.com'});
  scopes.forEach(s => s.done());
  assert.equal('abc123', client.credentials.access_token);
});

it('should refresh if access token is expired', (done) => {
  client.setCredentials({
    access_token: 'initial-access-token',
    refresh_token: 'refresh-token-placeholder',
    expiry_date: (new Date()).getTime() - 1000
  });
  const scopes = mockExample();
  client.request({url: 'http://example.com'}, () => {
    scopes.forEach(s => s.done());
    assert.equal('abc123', client.credentials.access_token);
    done();
  });
});

it('should refresh if access token will expired soon and time to refresh before expiration is set',
   async () => {
     const client = new OAuth2Client({
       clientId: CLIENT_ID,
       clientSecret: CLIENT_SECRET,
       redirectUri: REDIRECT_URI,
       eagerRefreshThresholdMillis: 5000
     });
     client.credentials = {
       access_token: 'initial-access-token',
       refresh_token: 'refresh-token-placeholder',
       expiry_date: (new Date()).getTime() + 3000
     };
     const scopes = mockExample();
     await client.request({url: 'http://example.com'});
     assert.equal('abc123', client.credentials.access_token);
     scopes.forEach(s => s.done());
   });

it('should not refresh if access token will not expire soon and time to refresh before expiration is set',
   async () => {
     const client = new OAuth2Client({
       clientId: CLIENT_ID,
       clientSecret: CLIENT_SECRET,
       redirectUri: REDIRECT_URI,
       eagerRefreshThresholdMillis: 5000
     });
     client.credentials = {
       access_token: 'initial-access-token',
       refresh_token: 'refresh-token-placeholder',
       expiry_date: (new Date()).getTime() + 10000,
     };
     const scopes = mockExample();
     await client.request({url: 'http://example.com'});
     assert.equal('initial-access-token', client.credentials.access_token);
     assert.equal(false, scopes[0].isDone());
     scopes[1].done();
   });

it('should not refresh if not expired', done => {
  client.credentials = {
    access_token: 'initial-access-token',
    refresh_token: 'refresh-token-placeholder',
    expiry_date: (new Date()).getTime() + 500000
  };
  const scopes = mockExample();
  client.request({url: 'http://example.com'}, () => {
    assert.equal('initial-access-token', client.credentials.access_token);
    assert.equal(false, scopes[0].isDone());
    scopes[1].done();
    done();
  });
});

it('should assume access token is not expired', done => {
  client.credentials = {
    access_token: 'initial-access-token',
    refresh_token: 'refresh-token-placeholder'
  };
  const scopes = mockExample();
  client.request({url: 'http://example.com'}, () => {
    assert.equal('initial-access-token', client.credentials.access_token);
    assert.equal(false, scopes[0].isDone());
    scopes[1].done();
    done();
  });
});

[401, 403].forEach(code => {
  it(`should refresh token if the server returns ${code}`, done => {
    const scope = nock('http://example.com').get('/access').reply(code, {
      error: {code, message: 'Invalid Credentials'}
    });
    const scopes = mockExample();
    client.credentials = {
      access_token: 'initial-access-token',
      refresh_token: 'refresh-token-placeholder'
    };
    client.request({url: 'http://example.com/access'}, err => {
      scope.done();
      scopes[0].done();
      assert.equal('abc123', client.credentials.access_token);
      done();
    });
  });
});

it('should not retry requests with streaming data', done => {
  const s = fs.createReadStream('./test/fixtures/public.pem');
  const scope = nock('http://example.com').post('/').reply(401);
  client.credentials = {
    access_token: 'initial-access-token',
    refresh_token: 'refresh-token-placeholder'
  };
  client.request({method: 'POST', url: 'http://example.com', data: s}, err => {
    scope.done();
    const e = err as AxiosError;
    assert(e);
    assert.equal(e.response!.status, 401);
    done();
  });
});

it('should generate revoke URL', done => {
  const url = OAuth2Client.getRevokeTokenUrl('abc');
  assert.equal(url, 'https://accounts.google.com/o/oauth2/revoke?token=abc');
  done();
});

it('should generate revoke URL with JSONP', done => {
  const url = OAuth2Client.getRevokeTokenUrl('abc', 'cb');
  assert.equal(
      url, 'https://accounts.google.com/o/oauth2/revoke?token=abc&callback=cb');
  done();
});

it('should revoke credentials if access token present', done => {
  const scope = nock('https://accounts.google.com')
                    .get('/o/oauth2/revoke?token=abc')
                    .reply(200, {success: true});
  client.credentials = {access_token: 'abc', refresh_token: 'abc'};
  client.revokeCredentials((err, result) => {
    assert.equal(err, null);
    assert.equal(result!.data!.success, true);
    assert.equal(JSON.stringify(client.credentials), '{}');
    scope.done();
    done();
  });
});

it('should clear credentials and return error if no access token to revoke',
   done => {
     client.credentials = {refresh_token: 'abc'};
     client.revokeCredentials((err, result) => {
       assert.equal(err!.message, 'No access token to revoke.');
       assert.equal(result, null);
       assert.equal(JSON.stringify(client.credentials), '{}');
       done();
     });
   });

it('getToken should allow a code_verifier to be passed', async () => {
  const scope =
      nock(baseUrl)
          .post('/oauth2/v4/token', undefined, {
            reqheaders: {'Content-Type': 'application/x-www-form-urlencoded'}
          })
          .reply(
              200, {access_token: 'abc', refresh_token: '123', expires_in: 10});
  const res =
      await client.getToken({code: 'code here', codeVerifier: 'its_verified'});
  scope.done();
  assert(res.res);
  if (!res.res) return;
  const params = qs.parse(res.res.config.data);
  assert(params.code_verifier === 'its_verified');
});

it('getToken should set redirect_uri if not provided in options', async () => {
  const scope =
      nock(baseUrl)
          .post('/oauth2/v4/token', undefined, {
            reqheaders: {'Content-Type': 'application/x-www-form-urlencoded'}
          })
          .reply(
              200, {access_token: 'abc', refresh_token: '123', expires_in: 10});
  const res = await client.getToken({code: 'code here'});
  scope.done();
  assert(res.res);
  if (!res.res) return;
  const params = qs.parse(res.res.config.data);
  assert.equal(params.redirect_uri, REDIRECT_URI);
});

it('getToken should set client_id if not provided in options', async () => {
  const scope =
      nock(baseUrl)
          .post('/oauth2/v4/token', undefined, {
            reqheaders: {'Content-Type': 'application/x-www-form-urlencoded'}
          })
          .reply(
              200, {access_token: 'abc', refresh_token: '123', expires_in: 10});
  const res = await client.getToken({code: 'code here'});
  scope.done();
  assert(res.res);
  if (!res.res) return;
  const params = qs.parse(res.res.config.data);
  assert.equal(params.client_id, CLIENT_ID);
});

it('getToken should override redirect_uri if provided in options', async () => {
  const scope =
      nock(baseUrl)
          .post('/oauth2/v4/token', undefined, {
            reqheaders: {'Content-Type': 'application/x-www-form-urlencoded'}
          })
          .reply(
              200, {access_token: 'abc', refresh_token: '123', expires_in: 10});
  const res =
      await client.getToken({code: 'code here', redirect_uri: 'overridden'});
  scope.done();
  assert(res.res);
  if (!res.res) return;
  const params = qs.parse(res.res.config.data);
  assert.equal(params.redirect_uri, 'overridden');
});

it('getToken should override client_id if provided in options', async () => {
  const scope =
      nock(baseUrl)
          .post('/oauth2/v4/token', undefined, {
            reqheaders: {'Content-Type': 'application/x-www-form-urlencoded'}
          })
          .reply(
              200, {access_token: 'abc', refresh_token: '123', expires_in: 10});
  const res =
      await client.getToken({code: 'code here', client_id: 'overridden'});
  scope.done();
  assert(res.res);
  if (!res.res) return;
  const params = qs.parse(res.res.config.data);
  assert.equal(params.client_id, 'overridden');
});

it('should return expiry_date', done => {
  const now = (new Date()).getTime();
  const scope =
      nock(baseUrl)
          .post('/oauth2/v4/token', undefined, {
            reqheaders: {'Content-Type': 'application/x-www-form-urlencoded'}
          })
          .reply(
              200, {access_token: 'abc', refresh_token: '123', expires_in: 10});
  client.getToken('code here', (err, tokens) => {
    assert(tokens!.expiry_date! >= now + (10 * 1000));
    assert(tokens!.expiry_date! <= now + (15 * 1000));
    scope.done();
    done();
  });
});

it('should accept custom authBaseUrl and tokenUrl', async () => {
  const authBaseUrl = 'http://authBaseUrl.com';
  const tokenUrl = 'http://tokenUrl.com';
  const client = new OAuth2Client(
      CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, {authBaseUrl, tokenUrl});
  const authUrl = client.generateAuthUrl();
  const authUrlParts = url.parse(authUrl);
  assert.equal(
      authBaseUrl.toLowerCase(),
      authUrlParts.protocol + '//' + authUrlParts.hostname);
  const scope = nock(tokenUrl).post('/').reply(200, {});
  const result = await client.getToken('12345');
  scope.done();
});

it('should obtain token info', async () => {
  const accessToken = 'abc';
  const tokenInfo = {
    aud: 'naudience',
    user_id: '12345',
    scope: 'scope1 scope2',
    expires_in: 1234
  };

  const scope = nock(baseUrl)
                    .get(`/oauth2/v3/tokeninfo?access_token=${accessToken}`)
                    .reply(200, tokenInfo);

  const info = await client.getTokenInfo(accessToken);
  scope.done();
  assert.equal(info.aud, tokenInfo.aud);
  assert.equal(info.user_id, tokenInfo.user_id);
  assert.deepEqual(info.scopes, tokenInfo.scope.split(' '));
});
