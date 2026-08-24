import assert from "node:assert/strict";
import test from "node:test";

import {
  currentUserStorage,
  runWithUserStorage,
  userStorageRoot,
  type UserStorageIdentity,
} from "../../src/tianjiang/runtime/user-storage-context";

const USER_ID = 42;
const FIRST_ISSUER = "https://central-a.example.com";
const SECOND_ISSUER = "https://central-b.example.com";

test("用户存储命名空间同时绑定中央发行方和用户 ID", () => {
  const first: UserStorageIdentity = { issuer: FIRST_ISSUER, userId: USER_ID };
  const second: UserStorageIdentity = { issuer: SECOND_ISSUER, userId: USER_ID };

  assert.notEqual(userStorageRoot("D:\\data", first), userStorageRoot("D:\\data", second));
  runWithUserStorage(first, () => {
    assert.equal(currentUserStorage()?.issuer, FIRST_ISSUER);
    assert.equal(currentUserStorage()?.userId, USER_ID);
  });
});

test("发行方缺失或含凭据时必须失败关闭", () => {
  assert.throws(
    () => userStorageRoot("D:\\data", { issuer: "", userId: USER_ID }),
    /发行方/,
  );
  assert.throws(
    () => userStorageRoot("D:\\data", {
      issuer: "https://name:secret@central.example.com",
      userId: USER_ID,
    }),
    /发行方/,
  );
});
