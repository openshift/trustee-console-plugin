const fs = require('fs');
const path = require('path');
const pluralize = require('pluralize');
const common = require('./common.js');

const publicDir = path.join(__dirname, './../locales/');

function determineRule(key) {
  if (key.includes('WithCount_plural')) {
    return 0;
  }
  if (key.includes('WithCount')) {
    return 1;
  }
  if (key.endsWith('_plural')) {
    return 2;
  }
  // i18next v21+ plural suffixes (English: _one / _other) — appended to the
  // base key whenever a t() call passes `count`. Default the value to the base
  // text (suffix stripped); otherwise the default-fill copies the suffix into
  // the rendered English ("2 restarts_other").
  if (key.endsWith('_one')) {
    return 4;
  }
  if (key.endsWith('_other')) {
    return 5;
  }
  return 3;
}

function updateFile(fileName) {
  const file = require(fileName);
  const updatedFile = {};

  const keys = Object.keys(file);

  let originalKey;

  for (let i = 0; i < keys.length; i++) {
    if (file[keys[i]] === '') {
      // follow i18next rules
      // "key": "item",
      // "key_plural": "items",
      // "keyWithCount": "{{count}} item",
      // "keyWithCount_plural": "{{count}} items"
      switch (determineRule(keys[i])) {
        case 0:
          [originalKey] = keys[i].split('WithCount_plural');
          updatedFile[keys[i]] = `{{count}} ${pluralize(originalKey)}`;
          break;
        case 1:
          [originalKey] = keys[i].split('WithCount');
          updatedFile[keys[i]] = `{{count}} ${originalKey}`;
          break;
        case 2:
          [originalKey] = keys[i].split('_plural');
          updatedFile[keys[i]] = pluralize(originalKey);
          break;
        case 4:
        case 5: {
          const suffix = keys[i].endsWith('_one') ? '_one' : '_other';
          updatedFile[keys[i]] = keys[i].slice(0, -suffix.length);
          break;
        }
        default:
          updatedFile[keys[i]] = keys[i];
      }
    } else {
      updatedFile[keys[i]] = file[keys[i]];
    }
  }

  fs.promises
    .writeFile(fileName, JSON.stringify(updatedFile, null, 2))
    .catch((e) => console.error(fileName, e));
}

function processLocalesFolder(filePath) {
  if (path.basename(filePath) === 'en') {
    common.parseFolder(filePath, updateFile);
  }
}

common.parseFolder(publicDir, processLocalesFolder);
