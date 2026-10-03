from app.services.directions import maneuvers_from_geometry, steps_from_ors

GEOM = [[26.92, 75.80], [26.93, 75.80], [26.93, 75.81]]


def test_geometry_maneuver_is_a_right_turn():
    steps = maneuvers_from_geometry(GEOM)
    assert steps[0]["maneuver"] == "depart"
    assert any(step["maneuver"] == "right" for step in steps)
    assert steps[-1]["maneuver"] == "arrive"
    assert steps[-1]["index"] == len(GEOM) - 1


def test_ors_steps_keep_instruction_and_index():
    properties = {
        "segments": [{
            "steps": [
                {"instruction": "Head north", "type": 11, "distance": 400, "name": "MI Road", "way_points": [0, 1]},
                {"instruction": "Turn right", "type": 1, "distance": 500, "name": "Amber Road", "way_points": [1, 2]},
                {"instruction": "Arrive", "type": 10, "distance": 0, "name": "", "way_points": [2, 2]},
            ]
        }]
    }
    steps = steps_from_ors(properties, GEOM)
    assert [step["maneuver"] for step in steps] == ["depart", "right", "arrive"]
    assert steps[1]["instruction"] == "Turn right"
    assert steps[1]["index"] == 1
    assert steps[1]["latitude"] == GEOM[1][0]
