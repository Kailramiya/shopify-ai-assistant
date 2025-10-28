import React, { useState } from "react";

function ChatWidget() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);

  const API_BASE = (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || "http://localhost:3000";

  const ask = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      setAnswer(data.answer || JSON.stringify(data));
    } catch (err) {
      setAnswer("Error contacting backend: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ border: "1px solid #ccc", padding: 20, width: 300 }}>
      <h3>Ask a Question</h3>
      <input
        value={question}
        onChange={e => setQuestion(e.target.value)}
        style={{ width: "100%" }}
        placeholder="Type a question about your site"
      />
      <button onClick={ask} disabled={loading || !question.trim()} style={{ marginTop: 8 }}>
        {loading ? "Thinking…" : "Ask"}
      </button>
      <div style={{ marginTop: 12 }}>
        <strong>Answer: </strong>
        <div style={{ whiteSpace: 'pre-wrap' }}>{answer}</div>
      </div>
    </div>
  );
}

export default ChatWidget;
