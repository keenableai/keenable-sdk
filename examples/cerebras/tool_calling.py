"""Let a Cerebras model decide when to search the web, via tool calling.

    pip install keenable cerebras_cloud_sdk
    export CEREBRAS_API_KEY="..."
    export KEENABLE_API_KEY="..."
    python tool_calling.py
"""

import os

from cerebras.cloud.sdk import Cerebras

from keenable import TOOLS, Keenable, KeenableError, run_tool_call

MODEL = "gpt-oss-120b"
QUESTION = "What did Cerebras announce most recently, and when?"

keenable = Keenable(api_key=os.environ.get("KEENABLE_API_KEY"))
cerebras = Cerebras(api_key=os.environ.get("CEREBRAS_API_KEY"))

messages = [
    {
        "role": "system",
        "content": (
            "You are a research assistant. Use the web tools whenever the "
            "answer depends on recent information, and cite the URLs you used."
        ),
    },
    {"role": "user", "content": QUESTION},
]

# TOOLS holds OpenAI-compatible definitions for keenable_search and
# keenable_fetch, so they go straight into the request.
while True:
    completion = cerebras.chat.completions.create(
        model=MODEL, messages=messages, tools=TOOLS
    )
    message = completion.choices[0].message
    tool_calls = getattr(message, "tool_calls", None)

    if not tool_calls:
        print(message.content)
        break

    messages.append(message.model_dump())
    for call in tool_calls:
        # run_tool_call executes whichever tool the model picked and returns
        # text ready to hand back.
        try:
            output = run_tool_call(
                keenable, call.function.name, call.function.arguments
            )
        except KeenableError as exc:
            # Hand the failure back as the tool result so the model can try
            # another source instead of the run dying on one bad URL.
            output = f"Tool call failed: {exc}"

        messages.append(
            {"role": "tool", "tool_call_id": call.id, "content": output}
        )
