import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClientControlPlanePath,
  matchClientControlPlaneEndpoint,
  validateClientControlPlaneRequest,
} from "../../src/tianjiang/client-control-plane-contracts";

test("客户端补充契约开放邀请待办、拒绝与项目创建", () => {
  assert.equal(
    matchClientControlPlaneEndpoint("GET", "/api/tianjiang/v1/team-invitations"),
    "listTeamInvitations",
  );
  assert.equal(
    matchClientControlPlaneEndpoint(
      "POST",
      "/api/tianjiang/v1/team-invitations/invitation-1/reject",
    ),
    "rejectTeamInvitation",
  );
  assert.equal(
    matchClientControlPlaneEndpoint("POST", "/api/tianjiang/v1/projects"),
    "createProject",
  );
});

test("用户名邀请与项目归属请求在本地代理前严格校验", () => {
  assert.deepEqual(
    validateClientControlPlaneRequest("inviteTeamMember", {
      username: " Alice_01 ",
      role: "editor",
    }),
    { username: "alice_01", role: "editor" },
  );
  for (const username of ["Alice-01", "Alice.01"]) {
    assert.deepEqual(
      validateClientControlPlaneRequest("inviteTeamMember", {
        username,
        role: "viewer",
      }),
      { username: username.toLowerCase(), role: "viewer" },
    );
  }
  assert.throws(
    () => validateClientControlPlaneRequest("inviteTeamMember", {
      userId: 7,
      role: "editor",
    }),
    /username/,
  );
  assert.deepEqual(
    validateClientControlPlaneRequest("createProject", {
      name: "团队项目",
      scope: "team",
      teamUuid: "team-1",
      teamName: "客户端伪造名",
      businessType: "novel",
    }),
    {
      name: "团队项目",
      scope: "team",
      teamUuid: "team-1",
      businessType: "novel",
    },
  );
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "个人项目",
      scope: "personal",
      teamUuid: "team-1",
    }),
    /personal/,
  );
  assert.throws(
    () => validateClientControlPlaneRequest("createProject", {
      name: "旧字段项目",
      kind: "personal",
    }),
    /scope/,
  );
});

test("客户端补充契约严格校验路径参数并拒绝路径穿越", () => {
  assert.equal(
    buildClientControlPlanePath("rejectTeamInvitation", {
      invitation_uuid: "invite / 1",
    }),
    "/tianjiang/v1/team-invitations/invite%20%2F%201/reject",
  );
  assert.throws(
    () => buildClientControlPlanePath("rejectTeamInvitation"),
    /invitation_uuid/,
  );
  assert.equal(
    matchClientControlPlaneEndpoint(
      "POST",
      "/api/tianjiang/v1/team-invitations/%2e%2e/reject",
    ),
    null,
  );
});
