import express from "express";

const router = express.Router();

export default router.get("/", (req, res) => {
  const session = (req as any).centralSession;
  res.status(200).send({ code: 0, data: { user: session.user }, message: "会话有效" });
});
