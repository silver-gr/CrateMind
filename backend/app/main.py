"""Normal source web entry point: uvicorn app.main:app."""
from .app_factory import create_app

app = create_app()
