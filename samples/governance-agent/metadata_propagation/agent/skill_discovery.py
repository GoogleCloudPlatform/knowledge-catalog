import os
import sys


def discover_skills(query: str):
    skills_dir = ".agents/skills"
    if not os.path.exists(skills_dir):
        print(f"Error: Skills directory '{skills_dir}' not found.")
        return

    skills = [f for f in os.listdir(skills_dir) if f.endswith(".md")]
    recommendations = []

    query_words = set(query.lower().split())

    for skill_file in skills:
        path = os.path.join(skills_dir, skill_file)
        with open(path) as f:
            content = f.read().lower()

            # Simple keyword matching
            score = 0
            # Match filename
            if any(word in skill_file.lower() for word in query_words):
                score += 5

            # Match content
            for word in query_words:
                if word in content:
                    score += 1

            if score > 0:
                recommendations.append((skill_file, score))

    # Sort by score descending
    recommendations.sort(key=lambda x: x[1], reverse=True)

    if recommendations:
        print(f"\nRecommended Skills for '{query}':")
        for skill, score in recommendations[:3]:
            print(f"- {skill} (Score: {score})")
    else:
        print(
            f"\nNo specific skills found for '{query}'. Referring to Mission Control README."
        )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print('Usage: python agent/skill_discovery.py "query string"')
    else:
        discover_skills(sys.argv[1])
