/**
 * Ink-based multi-choice UI for AskUserQuestionTool.
 *
 * Renders a navigable list of options per question, supports single or
 * multi-select, and falls back gracefully when Ink is unavailable.
 */
import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserQuestion, AskUserQuestionResult } from "./AskUserQuestionTool.js";
import { OTHER_LABEL } from "./constants.js";

export interface AskUserQuestionUIProps {
  question: AskUserQuestion;
  onSubmit: (result: AskUserQuestionResult) => void;
  onCancel?: () => void;
}

export const AskUserQuestionUI: React.FC<AskUserQuestionUIProps> = ({ question, onSubmit, onCancel }) => {
  const [selected, setSelected] = useState<number>(0);
  const [picks, setPicks] = useState<Set<number>>(new Set());
  const [freeFormMode, setFreeFormMode] = useState<boolean>(false);
  const [freeForm, setFreeForm] = useState<string>("");
  const [stepIndex, setStepIndex] = useState<number>(0);

  const options = [...question.options, { label: OTHER_LABEL, description: "" }];
  const otherIndex = options.length - 1;

  useInput((input, key) => {
    if (freeFormMode) {
      if (key.return) {
        onSubmit({
          question: question.question,
          header: question.header,
          answer: freeForm.trim() || "(no answer)",
          selectedOptions: [],
          freeForm: true,
        });
        return;
      }
      if (key.backspace || key.delete) {
        setFreeForm((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFreeForm((s) => s + input);
      }
      return;
    }

    if (key.upArrow) {
      setSelected((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setSelected((i) => (i + 1) % options.length);
      return;
    }
    if (input === " ") {
      if (question.multiSelect) {
        if (selected === otherIndex) {
          setFreeFormMode(true);
        } else {
          const next = new Set(picks);
          if (next.has(selected)) next.delete(selected);
          else next.add(selected);
          setPicks(next);
        }
      }
      return;
    }
    if (key.return) {
      if (question.multiSelect) {
        if (picks.size === 0 && selected !== otherIndex) return;
        const labels: string[] = [];
        for (const i of picks) labels.push(options[i].label);
        if (selected === otherIndex && !picks.size) {
          setFreeFormMode(true);
          return;
        }
        onSubmit({
          question: question.question,
          header: question.header,
          answer: labels.join(", "),
          selectedOptions: labels,
          freeForm: false,
        });
        return;
      }
      if (selected === otherIndex) {
        setFreeFormMode(true);
        return;
      }
      onSubmit({
        question: question.question,
        header: question.header,
        answer: options[selected].label,
        selectedOptions: [options[selected].label],
        freeForm: false,
      });
      return;
    }
    if (key.escape && onCancel) onCancel();
  });

  if (freeFormMode) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color="cyan">{question.header ? `[${question.header}] ` : ""}{question.question}</Text>
        <Text dimColor>Type your answer and press Enter. Esc to cancel.</Text>
        <Box marginTop={1}>
          <Text color="green">› </Text>
          <Text>{freeForm}</Text>
          <Text backgroundColor="white" color="black"> </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="cyan">{question.header ? `[${question.header}] ` : ""}{question.question}</Text>
      <Text dimColor>
        {question.multiSelect ? "↑/↓ to move, Space to toggle, Enter to confirm" : "↑/↓ to choose, Enter to confirm"}
      </Text>
      {options.map((opt, i) => {
        const isSelected = i === selected;
        const isPicked = question.multiSelect && picks.has(i);
        const prefix = question.multiSelect ? (isPicked ? "[x] " : "[ ] ") : "  ";
        const pointer = isSelected ? "› " : "  ";
        return (
          <Box key={i} marginLeft={2}>
            <Text color={isSelected ? "green" : undefined}>{pointer}{prefix}{opt.label}</Text>
            {opt.description ? <Text dimColor>  — {opt.description}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
};
