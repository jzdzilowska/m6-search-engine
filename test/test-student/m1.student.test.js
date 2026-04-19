/*
    In this file, add your own test cases that correspond to functionality introduced for each milestone.
    You should fill out each test case so it adequately tests the functionality you implemented.
    You are left to decide what the complexity of each test case should be, but trivial test cases that abuse this flexibility might be subject to deductions.

    Imporant: Do not modify any of the test headers (i.e., the test('header', ...) part). Doing so will result in grading penalties.
*/

const distribution = require('../../distribution.js')();
require('../helpers/sync-guard');
const util = distribution.util;

// 1: number (including special values NaN, Infinity, -Infinity)
test('(1 pts) student test', () => {
  const num = 42;
  expect(util.deserialize(util.serialize(num))).toEqual(num);

  const negNum = -17;
  expect(util.deserialize(util.serialize(negNum))).toEqual(negNum);

  const float = 3.14159;
  expect(util.deserialize(util.serialize(float))).toBeCloseTo(float);

  // special
  const nan = NaN;
  expect(util.deserialize(util.serialize(nan))).toBeNaN();

  const inf = Infinity;
  expect(util.deserialize(util.serialize(inf))).toEqual(Infinity);

  const negInf = -Infinity;
  expect(util.deserialize(util.serialize(negInf))).toEqual(-Infinity);
});


// Test 2: string
test('(1 pts) student test', () => {
  const str = 'hello world';
  expect(util.deserialize(util.serialize(str))).toEqual(str);

  const emptyStr = '';
  expect(util.deserialize(util.serialize(emptyStr))).toEqual(emptyStr);

  // special chars
  const specialStr = 'line1\nline2\ttab"quote\'apostrophe\\backslash';
  expect(util.deserialize(util.serialize(specialStr))).toEqual(specialStr);

  // unicode
  const unicodeStr = 'Hello 世界 🌍';
  expect(util.deserialize(util.serialize(unicodeStr))).toEqual(unicodeStr);
});


// Test 3: boolean, null, undefined
test('(1 pts) student test', () => {
  const boolTrue = true;
  expect(util.deserialize(util.serialize(boolTrue))).toEqual(true);

  const boolFalse = false;
  expect(util.deserialize(util.serialize(boolFalse))).toEqual(false);

  const nullVal = null; // TODO
  expect(util.deserialize(util.serialize(nullVal))).toBeNull();

  const undefVal = undefined; // TODO
  expect(util.deserialize(util.serialize(undefVal))).toBeUndefined();
});

// Test 4: array (including nested arrays)
test('(1 pts) student test', () => {
  const arr = [1, 2, 3, 4, 5];
  expect(util.deserialize(util.serialize(arr))).toEqual(arr);

  // empty
  const emptyArr = [];
  expect(util.deserialize(util.serialize(emptyArr))).toEqual(emptyArr);

  // mixed type
  const mixedArr = [1, 'two', true, null, undefined];
  expect(util.deserialize(util.serialize(mixedArr))).toEqual(mixedArr);

  // nested
  const nestedArr = [[1, 2], [3, [4, 5]]];
  expect(util.deserialize(util.serialize(nestedArr))).toEqual(nestedArr);
});

// Test 5: object (including nested)
test('(1 pts) student test', () => {
  const obj = {a: 1, b: 2, c: 3};
  expect(util.deserialize(util.serialize(obj))).toEqual(obj);

  // empty
  const emptyObj = {};
  expect(util.deserialize(util.serialize(emptyObj))).toEqual(emptyObj);

  // nested
  const nestedObj = {
    outer: {
      inner: {
        deep: 'value',
      },
    },
  };
  expect(util.deserialize(util.serialize(nestedObj))).toEqual(nestedObj);

  // mixed types
  const mixedObj = {
    num: 42,
    str: 'hello',
    bool: true,
    nil: null,
    arr: [1, 2, 3],
  };
  expect(util.deserialize(util.serialize(mixedObj))).toEqual(mixedObj);
});
