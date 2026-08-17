import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start exam test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, token = "", init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }
  });
  return { response, json: await response.json().catch(() => ({})) };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", { method: "POST", body: JSON.stringify({ email, password: "goodjob123" }) });
  assert.equal(result.response.status, 200, `login failed: ${email}`);
  return String(result.json.token);
}

try {
  const manager = await login("alex@goodjob.com");
  const assignedSales = await login("shirley@goodjob.com");
  const unassignedSales = await login("mia@goodjob.com");

  const question = await request("/api/exam-questions", manager, {
    method: "POST",
    body: JSON.stringify({
      stem: "专项测试：报价前应先确认什么？",
      category: "考试重构测试",
      options: ["需求与规格", "头像颜色", "办公桌尺寸"],
      answerIndex: 0,
      explanation: "先确认真实采购需求和产品规格。",
      difficulty: "easy"
    })
  });
  assert.equal(question.response.status, 200);

  const created = await request("/api/exams", manager, {
    method: "POST",
    body: JSON.stringify({
      title: `考试闭环测试-${Date.now()}`,
      category: "考试重构测试",
      questionIds: [question.json.question.id],
      durationMinutes: 20,
      passScore: 80,
      targetRole: "all",
      instructions: "自动化专项测试"
    })
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.json.exam.status, "draft");
  const examId = String(created.json.exam.id);

  const published = await request(`/api/exams/${examId}/publish`, manager, {
    method: "PATCH",
    body: JSON.stringify({ assigneeIds: ["u_sales_shirley"], maxAttempts: 1, allowReview: false })
  });
  assert.equal(published.response.status, 200);
  assert.equal(published.json.assignments.length, 1);

  const unassignedDetail = await request(`/api/exams/${examId}/detail`, unassignedSales);
  assert.equal(unassignedDetail.response.status, 404, "unassigned candidate must not see exam");
  const unassignedStart = await request(`/api/exams/${examId}/start`, unassignedSales, { method: "POST", body: "{}" });
  assert.equal(unassignedStart.response.status, 404, "unassigned candidate must not start exam");

  const candidateDetail = await request(`/api/exams/${examId}/detail`, assignedSales);
  assert.equal(candidateDetail.response.status, 200);
  assert.equal(candidateDetail.json.questions[0].answerIndex, -1);
  assert.deepEqual(candidateDetail.json.questions[0].answerIndexes, []);
  assert.equal(candidateDetail.json.questions[0].explanation, "");

  const started = await request(`/api/exams/${examId}/start`, assignedSales, { method: "POST", body: "{}" });
  assert.equal(started.response.status, 201);
  assert.equal(started.json.attempt.status, "in_progress");
  const attemptId = String(started.json.attempt.id);
  const resumed = await request(`/api/exams/${examId}/start`, assignedSales, { method: "POST", body: "{}" });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.json.resumed, true);
  assert.equal(resumed.json.attempt.id, attemptId);

  const foreignSave = await request(`/api/exam-attempts/${attemptId}/answers`, unassignedSales, {
    method: "PATCH",
    body: JSON.stringify({ answers: { [question.json.question.id]: 0 } })
  });
  assert.equal(foreignSave.response.status, 404, "another user must not modify attempt");

  const saved = await request(`/api/exam-attempts/${attemptId}/answers`, assignedSales, {
    method: "PATCH",
    body: JSON.stringify({ answers: { [question.json.question.id]: 0 } })
  });
  assert.equal(saved.response.status, 200);

  const bankQuestion = getStore().examQuestions.find((item) => item.id === question.json.question.id);
  assert.ok(bankQuestion);
  bankQuestion.answerIndex = 1;
  bankQuestion.answerIndexes = [1];

  const submitted = await request(`/api/exam-attempts/${attemptId}/submit`, assignedSales, { method: "POST", body: "{}" });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.json.attempt.score, 100, "published snapshot must control grading");
  assert.equal(submitted.json.canReview, false);
  assert.equal(submitted.json.questions[0].answerIndex, -1);

  const retry = await request(`/api/exams/${examId}/start`, assignedSales, { method: "POST", body: "{}" });
  assert.equal(retry.response.status, 409, "max attempts must be enforced");

  const results = await request(`/api/exams/${examId}/results`, manager);
  assert.equal(results.response.status, 200);
  assert.equal(results.json.assignments.length, 1);
  assert.equal(results.json.assignments[0].status, "passed");
  assert.equal(results.json.assignments[0].bestScore, 100);

  console.log("exam-system-test: passed", {
    assignmentIsolation: true,
    answerRedaction: true,
    resumableAttempt: true,
    attemptOwnership: true,
    snapshotScoring: true,
    maxAttempts: true,
    resultAggregation: true
  });
} finally {
  server.close();
}
