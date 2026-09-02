table 100000 "TSC Translation Demo"
{
    Caption = 'Translation Demo';
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Code"; Code[20])
        {
            Caption = 'Code';
            ToolTip = 'Specifies the code that identifies the demo entry.';
        }
        field(2; Description; Text[100])
        {
            Caption = 'Description';
            ToolTip = 'Specifies a description of the demo entry.';
        }
        field(3; Blocked; Boolean)
        {
            Caption = 'Blocked';
            ToolTip = 'Specifies whether the demo entry is blocked for further processing.';
        }
    }

    keys
    {
        key(PK; "Code")
        {
            Clustered = true;
        }
    }
}
