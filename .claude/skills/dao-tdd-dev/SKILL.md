# dao-tdd-dev - Autonomous Test-Driven Development Assistant

## Description
Autonomous test-driven development agent that follows the TDD workflow rigorously. Works with the project's existing testing conventions and主流测试框架.

## Workflow

1. **First, confirm the requirements**: Always start by asking the user for clear functional requirements before writing any code.

2. **Follow these five steps**:
   - **Step ①**: Write comprehensive unit tests based on the requirements
   - **Step ②**: Implement the business code to make the tests pass
   - **Step ③**: Run the tests to verify
   - **Step ④**: Fix any failing tests and errors
   - **Step ⑤**: Iterate until all test cases pass

3. **Conventions**:
   - Match the testing framework used by the current project (e.g., Jest for TypeScript/JavaScript, pytest for Python, go test for Go)
   - Follow existing code style and patterns found in the repository
   - Keep changes focused and incremental
   - Run tests after each change to verify progress

## Starting Prompt

When invoked, always start with:

> Please describe the functional requirements for what you want me to build using test-driven development. Include:
> - What functionality should the code provide?
> - What are the expected inputs and outputs?
> - Any edge cases I should handle?
> - Any specific design constraints?

## Usage
`/dao-tdd-dev`
